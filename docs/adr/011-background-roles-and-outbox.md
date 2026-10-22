# ADR 011 - Background work crosses tenants through a dedicated role and the outbox only

- **Status**: accepted
- **Date**: 2026-10-21
- **Amends**: ADR 002 (adds one role), ADR 008 (confirms the Postgres-table queue)
- **Amended**: 2026-10-21 by ADR 019 rule 6 (intent row plus provider idempotency key plus reconciliation before retry); 2026-10-21 for TODO #7 (rule 1: the identity tables and `mycel_auth`); 2026-10-22 at the review of PR #7 (rule 1: the fronts enter `mycel_auth` from the `mycel_authenticator` login, never from the operator connection)

## Context

ADR 002 gives the application one role, `mycel_app`, which is bound by forced Row Level Security and sees exactly one tenant per transaction. The first vertical probe showed that one component legitimately needs to look across tenants: the outbox worker, which drains committed domain events and hands them to subscribers. Running it as `mycel_app` cannot work (no tenant context, zero rows); running it as the schema owner would bypass RLS on every table; granting `BYPASSRLS` needs a superuser and is just as broad.

## Decision

1. **Cross-tenant reads happen only on tables that are queues or logs for the platform itself**, today the `outbox` table. The one exception that is neither queue nor log is authentication: resolving an API key or an operator's memberships happens before a tenant context exists, so the identity tables (`operators`, `tenant_memberships`, `api_keys`) are read, and `operators` written, through the dedicated `mycel_auth` role under the discipline of rule 2 (migration 0007). The fronts enter `mycel_auth` from the `mycel_authenticator` login, a role with no rights of its own (`inherit false`) that can do nothing but `set local role mycel_auth`; web and API therefore never hold the schema owner's credentials, and the operator connection of rule 2 stays with migrations, the seed and the worker. Tenant-scoped management of members and keys runs as `mycel_app` under RLS like any use case. Tenant data (pages, forms, submissions, events, supporters, ledger) is never read across tenants by application code; platform reports use per-tenant transactions or a separate read model.
2. **A dedicated role per cross-tenant job, with a policy scoped to that role and that table.** The first is `mycel_worker` (migration 0003): `select, update` on `outbox`, policy `worker_drain ... to mycel_worker using (true)`. The operator connection does `set local role mycel_worker` for the duration of one drain transaction and nothing else.
3. **Subscribers run inside a normal tenant-scoped unit of work.** The worker reads an event, then calls each subscriber with a `system` principal for the event's tenant. The supporter ingest therefore writes under RLS like any use case.
4. **Delivery is at-least-once per subscriber.** The outbox row records which subscribers handled the event (`delivered_to`), attempts are capped with exponential backoff, and claiming uses `FOR UPDATE SKIP LOCKED` so several workers can run. Subscribers must be idempotent: ingest dedups on the deterministic event id; mail subscribers will record a send key before the first attempt (follow-up, see consequences).
5. **The outbox is the only event transport.** No broker, no `LISTEN/NOTIFY` as a source of truth (ADR 008). Partitioning or archiving processed rows is an operational migration, not a model change.

## Rejected alternatives

- **`BYPASSRLS` on the operator role**: one flag, but it opens every table to the component that least needs it, and it requires superuser to grant on managed Postgres.
- **A tenant loop in the worker** (iterate tenants, drain each under RLS): correct but O(tenants) queries per tick and it needs a cross-tenant list of tenants anyway.
- **Delivering events synchronously in the use case's transaction**: no worker, but a failing mail provider would roll back a signup, and the supporter module would be coupled to every publisher.

## Consequences

- Every new cross-tenant job (dunning scheduler, campaign sender, reconciliation) gets its own role and policy, or reuses `mycel_worker` only if it touches the same queue table. The RLS conformance test (TODO) asserts that every policy with `using (true)` is bound to a named worker role, never to `public` or `mycel_app`.
- Transactional mail sent from a subscriber must become idempotent before production: a `mail_sends` table keyed by `(event_id, subscriber)` written before the provider call.
- The `events` table partitioning promised in ADR 003 is still owed; it interacts with the `(tenant_id, id)` primary key used for dedup and gets its own migration and test.
