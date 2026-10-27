# ADR 019 - Supporter consistency, stable identity, effect recovery and retention

- **Status**: accepted
- **Date**: 2026-10-21
- **Amends**: ADR 003 (rules 1, 3 and 5), ADR 011 (rule 4), ADR 016 (rule 1)
- **Prompted by**: second-opinion review of 2026-10-21, finding 4

## Context

ADR 003 makes the supporter a projection over an append-only log and calls ingest "idempotent" and the projection "rebuildable". That leaves open: what an old event arriving after a newer one does, what two workers updating one supporter at the same time do, how temporary access expires without a new event, how an e-mail address changes, and how much reader activity the log keeps. ADR 011 promises a `mail_sends` key before the first attempt, which prevents neither loss nor duplication on its own when the provider call times out. The current ingest (`packages/core/src/supporters/service.ts`) reads the projection, applies one event and writes it back.

## Decision

1. **A supporter has a stable id next to the normalised e-mail address.** `supporter_id` (UUID) is assigned on first sight and is the key of events and projection; the e-mail address is a unique, mutable attribute per tenant. `supporter.email_changed` (old, new, evidence) and `supporter.merged` (source id into target id, by whom, why) are explicit, logged operations; merging is never automatic (ADR 003 rejected alternatives). External references (mandates, mail lists) point at the id.
2. **The projection is a fold over the log in `occurred_at` order with the event id as tie-break.** Ingesting an event that is older than the projection's `appliedThrough` does not apply it on top; it appends the event and re-folds the supporter from the log (one supporter, cheap). A late `newsletter.subscribed` arriving after `consent.withdrawn` therefore leaves the supporter unsubscribed.
3. **One supporter is updated by one writer at a time.** The projector takes a per-supporter lock (`SELECT ... FOR UPDATE` on the projection row, or an advisory lock keyed by `(tenant_id, supporter_id)` before the row exists) for the duration of append-and-fold. Two workers never interleave on the same supporter; different supporters run in parallel.
4. **Time-dependent state is evaluated at read time.** `access.granted` with `until`, consent with expiry, and a paid-through date are stored as facts; `hasAccess(reader, item, now)` and `canSend(list, supporter, now)` compute the answer. No sweeper writes "expired" events, and nothing caches the answer beyond one request.
5. **Consent and access are checked at the moment of use.** The sender checks current consent per recipient when a send is claimed, not when a campaign is composed; the read route checks access on every request.
6. **External effects have a recovery contract.** Every call to a provider (mail, payment) is preceded by an intent row (`mail_sends`, `payment_attempts`) with a deterministic key, and the provider receives that key as its idempotency key where it supports one. A timeout leaves the intent in `unknown`; a reconciliation job queries the provider by key before any retry. Retries without reconciliation are forbidden for calls with side effects.
7. **Reader activity is retained as little as the feature needs.** `reader.signed_in` is kept as an event for `readers.activity_retention_days` (tenant setting, default 90) and then compacted into the projection's `lastSeenAt`; content views are never logged per reader. A tenant may set retention to 0 (projection only). This mirrors the privacy-light mode of the Dreamkit supporter registry.
8. **Erasure covers every copy.** `supporter.erase` tombstones the events (ADR 003 rule 5) and also purges form submissions, outbox payloads, queued mail and `mail_sends` rows that carry the address, and records the erased id in an `erasures` table so a restore from backup re-applies it. Backups expire within a documented window (`docs/self-hosting.md`).

## Rejected alternatives

- **E-mail address as the only key**: ADR 003's starting point; it makes an address change a merge of two people and leaks the address into every foreign key.
- **Apply events in arrival order**: the current code; simple, and it produces different projections for different arrival orders, which "rebuildable" promised not to happen.
- **A global ingest lock**: trivially correct and O(1) parallelism.
- **Materialising expiry with a sweeper**: one more job, one more race, and the sweeper's clock becomes the source of truth.

## Consequences

- The supporter work (PRs #5 and #6) grows: `supporter_id` and `supporter.email_changed`; fold-from-log with `appliedThrough`; per-supporter lock; `mail_sends` with `unknown` state and a reconciliation step; the database conformance suite gets a concurrency test (two events for one supporter in parallel transactions, projection equals the serial fold).
- ADR 011 rule 4's "record a send key before the first attempt" is read with rule 6 here.
- 2026-10-22 (PR #17, migration 0013): the reconciliation job of rule 6 is `mail.reconcile` on the jobs table, planned in the transaction that claims the attempt. TEM has no idempotency key, so "queries the provider by key" is a count over the provider's listing; `docs/reference/mail.md` has the contract and the residual risk.
- ADR 016 rule 1: the session is bound to `supporter_id`, and sign-in events follow rule 7.
- The event contract v1 stays: `supporter_id` is an envelope addition, not a redefinition.
