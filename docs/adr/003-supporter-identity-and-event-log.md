# ADR 003 - A supporter is an e-mail-centric identity plus an append-only event log

- **Status**: accepted
- **Date**: 2026-10-21
- **Amended**: 2026-10-21 by ADR 019 (stable `supporter_id`, fold order, per-supporter lock, retention, erasure scope); 2026-10-21, consequence 1: `events` is range-partitioned by month only, sub-partitioning per tenant is deferred (review of PR #4, recorded in the private planning repository on 2026-10-21)
- **Inherits**: the Dreamkit supporter event contract v1 (`wings.supporter-event.v1`, `dreamkit/docs/supporter-registry/event-contract.md`) and the "no state stealing" principle from the Dreamkit supporter-CRM brief.

## Context

Dreamkit's supporter registry was designed as the one thing nobody else owned: identity, activity and consent, with pointers to the source records in WordPress, Pronamic, Listmonk and Zammad. In Mycel most of those sources move in-house, which makes it tempting to model "the supporter" as a fat row with columns for everything. That would recreate the five-systems-with-drift problem inside one database.

## Decision

1. **Identity key is the normalised e-mail address** (lowercased, trimmed, per tenant). A supporter without an e-mail address does not exist for Mycel; phone-only or offline contacts are a later ADR if ever needed.
2. **Facts about a supporter are events, appended and never updated.** `petition.signed`, `donation.started`, `donation.payment.succeeded`, `newsletter.subscribed`, `consent.given`, `consent.withdrawn`, `membership.renewed`, ... Each event carries `occurred_at`, `source`, `source_ref`, typed `props`, and a deterministic `id` for idempotent ingest. The event-type registry and envelope follow the inherited contract; new types are additions, never redefinitions.
3. **The supporter record is a projection**: a per-person properties row (recurring donor?, last activity, lists, tags, consent state) rebuilt deterministically from the log. Any session may run `rebuild-projection` and get the same result. Queries and segments read the projection; nothing writes to it except the projector.
4. **Consent is an event with scope and evidence**, not a boolean: what was consented to (list, purpose), when, from which form or import, with which text version. Withdrawal is another event. The projection derives the current state.
5. **Erasure is a compensating action, not a delete**: the supporter's events are replaced by a tombstone that keeps the aggregate counts honest and removes the personal data; the audit trail of _that_ an erasure happened stays. Export (AVG/GDPR access request) is a projection of the log for one person.
6. **Other domains publish, the supporter domain subscribes.** Forms, donations and mailing emit domain events through the core's event port; the supporter module ingests them. Those modules never write supporter rows directly.

## Rejected alternatives

- **Mutable supporter table with columns**: simple reads, but every column is a sync problem and "why is this person marked recurring" has no answer. The log answers "why" by construction.
- **Full event sourcing of every aggregate**: overkill. Only the supporter domain is history-shaped; content, forms and tenants are ordinary CRUD with audit columns. The money ledger (ADR 005) is append-only for its own reasons.
- **Identity by phone or name matching**: fuzzy matching creates false merges, which for an activist organisation is a data-protection incident. Explicit merge is a manual, logged operation.

## Consequences

- The `events` table is the largest table in the system and is range-partitioned by month (`occurred_at`) from the start, with `tenant_id` leading every index and the primary key `(tenant_id, id, occurred_at)`; `occurred_at` is already part of the deterministic id, so dedup is unchanged. A default partition catches rows outside the created months and must stay empty (database conformance). Sub-partitioning per tenant is deferred until measured: it needs DDL per tenant and multiplies partitions by tenants, while a tenant's rows are already contiguous under the index and erasure is a tombstone, not a drop.
- Import of the existing Dreamkit registry is a backfill of events (source `backfill`), which the contract already defines.
- Segments are queries over the projection and are themselves stored as data (a small filter DSL), so an agent can create and explain one through MCP.
