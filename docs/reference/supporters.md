# Supporters

A supporter is one person per tenant, identified by a normalised e-mail address that resolves to a stable `supporter_id`, with an append-only event log as the source of truth and a projection folded from it. Other modules publish domain events; the supporter module subscribes, maps them onto the envelope `wings.supporter-event.v1` inherited from Dreamkit, appends them and folds ([ADR 003](../adr/003-supporter-identity-and-event-log.md), [ADR 019](../adr/019-supporter-consistency-identity-and-retention.md) rules 1 to 3). Code: `packages/core/src/supporters/`, `supporterRepository` in `packages/db/src/repositories.ts`, migration 0005. Erasure is described in [export.md](export.md#erasure-register); the consent flow that feeds the log in [mail.md](mail.md); the tables in [database.md](database.md).

## The envelope

`SupporterEvent` (`packages/core/src/supporters/events.ts`) keeps the Dreamkit schema id so a backfill from the predecessor needs no translation. A new event type is an addition to `SupporterEventType`; a changed meaning is a new schema id, never an edit.

| Field                                 | Content                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                              | `wings.supporter-event.v1`                                                                                                                                  |
| `id`                                  | deterministic dedup key: `sha1(source \| source_ref \| type \| occurred_at)`                                                                                |
| `supporter_id`                        | Mycel's addition; assigned at ingest, ignored on input                                                                                                      |
| `type`                                | `petition.signed`, `form.submitted`, `newsletter.*`, `consent.*`, `donation.*`, `event.rsvp`, `membership.*`, `supporter.erased`, `supporter.email_changed` |
| `email`                               | lower-cased and trimmed; for `supporter.email_changed` the address before the change                                                                        |
| `occurred_at`                         | ISO 8601 with offset                                                                                                                                        |
| `source`, `source_site`, `source_ref` | origin; Mycel writes `source: mycel` and `source_ref: submission:<id>` or `supporter:<id>`                                                                  |
| `props`                               | type-specific extras                                                                                                                                        |

Today the `supporters.ingest` subscriber maps `newsletter.subscribed` and `consent.given` from forms. A signup and its confirmation share `source_ref` and differ in type, so both ids are deterministic and distinct.

## Ingest

`ingest(ctx, event)` runs in one tenant transaction under a `system` principal:

1. **Lock** the address: a transaction-scoped advisory lock on `supporter:<tenant>:<address>` (`advisoryLock` in `packages/db/src/roles.ts`). Two workers on one supporter serialise; different supporters run in parallel.
2. **Resolve** the address to the projection's `id`, or a fresh UUIDv7 on first sight. The address decides, never a `supporter_id` on the input.
3. **Append** to `events`; a conflict on `(tenant_id, id, occurred_at)` is a duplicate and ends ingest without a fold, so ingest is idempotent.
4. **Fold**: if a projection exists and the event sorts after its `appliedThrough`, apply it on top; otherwise (a late event, or no projection) rebuild the projection of that one supporter from its whole log.
5. **Release** the supporter's admission seat under the tenant's admission lock, always after the address lock so the two cannot deadlock.

`events` is append-only for `mycel_app` (`select`, `insert`); only the projector writes `supporters`. There is no foreign key from `events` to `supporters`: the projection must be droppable and rebuildable without touching the log.

## The projection and fold order

`supporter.get` (capability `supporters:read`, MCP resource `mycel://supporters/{email}`) returns `id`, `email`, `firstSeen`, `lastActivity`, `lists` (confirmed consent; the only lists a sender may use), `pendingLists` (signed up, not yet confirmed) and `appliedThrough`.

Fold order is `occurred_at` compared as an instant, then `id` by code unit, which matches `collate "C"` on `events.id`. Because a late event triggers a re-fold, every arrival order of the same events ends in the same projection. List transitions: `newsletter.subscribed` with `confirmed: false` adds a pending list unless it is already confirmed; `newsletter.subscribed` without that flag, and `consent.given`, confirm it; `newsletter.unsubscribed` and `consent.withdrawn` remove it from both.

## Changing an address

`supporter.email.update` (capability `supporters:write`) takes `supporterId`, `newEmail` and a `reason` (the evidence: who asked, through which channel). It locks both addresses in sorted order, rereads the supporter, and refuses with `conflict` when the supporter changed meanwhile, another supporter holds the new address, or a change for the same supporter was recorded in the same millisecond. Otherwise it appends `supporter.email_changed` with `old_email`, `new_email` and `reason` and folds it; the address is never overwritten in place. After the change the old address no longer resolves: an event that still uses it starts a new supporter.

## Admission seats

`supporters.max` must hold before the worker has folded a signup, so `form.submit` reserves a seat in `supporter_admissions` (a hash of tenant and address, not the address) under the tenant's admission lock, and ingest releases it in the transaction that creates the projection. A reservation that never got its event stops counting after the admission window and is swept by the next reservation of that tenant.

## Partitions

`events` is range-partitioned by month on `occurred_at` (`events_YYYY_MM`), with an `events_default` partition that must stay empty: a row there blocks creating its month and `ensure_event_partitions` then refuses with a recovery hint. `migrate` creates partitions from `FIRST_EVENT_MONTH` up to three months ahead on every run; the worker's monthly `events.partitions` job (`createEventPartitions`) keeps that going from the current month without a deploy. A backfill or an import calls `ensureEventPartitions(db, from, to)` for its own range first. Only the schema owner may execute the function.

## Erasure

`ctx.erasures.register(supporterId, email)` records a permanent registration without the address; `ctx.erasures.apply()` (worker and `mycel erasures apply`, as `mycel_erasure`) turns every copy into a tombstone: events and the projection get `<supporter id>@erased.invalid` (`tombstoneEmail`; `.invalid` can never be delivered), empty props and empty lists, while type and time stay so counts still add up. A use case that registers an erasure is planned (ADR 019). Rows, roles, backups and restore are in [export.md](export.md#erasure-register).

## Constants

| Constant                    | Value               | Where                                                   | Why                                                                            |
| --------------------------- | ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| partitions ahead            | 3 months            | `packages/db/src/migrate.ts`, `packages/db/src/jobs.ts` | a missed monthly job still leaves months before rows hit the default partition |
| `FIRST_EVENT_MONTH`         | `2026-10-01`        | `packages/db/src/migrate.ts`                            | first month with partitions; older rows need their own range first             |
| `events.partitions` cadence | monthly             | `packages/api/src/jobs.ts`                              | keeps the three-month lead without a deploy                                    |
| `ADMISSION_WINDOW_MS`       | 7 days              | `packages/core/src/supporters/ports.ts`                 | a signup whose event never arrived must not hold a seat forever                |
| `supporters.max`            | 100,000 (default)   | `packages/core/src/entitlements/model.ts`               | supporters per tenant, projection plus live reservations                       |
| `reason`                    | 1 to 500 characters | `packages/core/src/supporters/service.ts`               | evidence for an address change                                                 |
| `ERASED_DOMAIN`             | `erased.invalid`    | `packages/core/src/supporters/erasure.ts`               | RFC 2606 reserved: a tombstone is never deliverable                            |
| `ERASURE_UNSECURED_WARN_MS` | 1 hour              | `packages/core/src/supporters/erasure.ts`               | four missed 15-minute erasure backups                                          |
