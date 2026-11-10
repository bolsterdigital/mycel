# ADR 032 - Erasure ends a lifecycle; explicit readmission starts another

- **Status**: accepted
- **Date**: 2026-11-10
- **Supersedes**: ADR 019 rule 8 only for the identity and time boundary of erasure; its every-copy and backup obligations remain
- **Refines**: ADR 003 rules 3 and 6 for retiring an erased projection during ingest

## Context

A permanent erasure of an address also destroys a later explicit signup. Keeping everything received later instead would turn a delayed old event or restored queue into new consent. The owner's decision is to retain explicit readmission after registration while erasing older and restored copies.

## Decision

1. An erasure permanently ends the registered supporter lifecycle. The append-only register remains keyed by supporter id and address hash. A new explicit signup after the latest registration starts a fresh supporter id. Repeated apply never folds the old tombstone into it; a second request registers the new id independently.
2. After an address has been registered, only a validated local signup or petition with active consent can open a lifecycle. In the signup transaction, a durable tenant-scoped lifecycle records its fresh id, address hash, submission id and server time. Later submissions may join that live lifecycle. At equal timestamps erasure wins: readmission must be strictly later. Arrival time and an event's claimed occurrence time alone never authorize readmission. Historical archives with no lifecycle evidence are preserved on import, but are not exemptions from a registered erasure.
3. The lifecycle id is server-owned provenance in the submission's pinned evaluation and its outbox events. Supporter ingest after an erasure requires that provenance, a matching extant submission and local source reference. It assigns the fresh id and retires a still-present erased projection before writing the new projection. Old or unproven events are ignored, including delayed confirmations. A typed provider withdrawal may carry its server-validated current submission as evidence; this only removes permission. Existing events keep their fold order within their own lifecycle.
4. Apply erases registered ids and copies carrying registered addresses unless they have valid, unregistered lifecycle provenance strictly after the latest registration of that address. Event/projection ids, pinned submissions and their outbox/effect dependencies carry that provenance. Arbitrary free-text jobs without provenance are never exempt merely because they were created later. Old backup copies without a projection are still found by hash. No address is stored in the lifecycle table.
5. Registration, explicit admission, ingest and apply use the same transaction-scoped per-address hash lock. Apply takes the known registered hashes in sorted order and re-reads the register under those locks. A concurrent new registration not in that set is handled by the next apply. Mail/connector source checks refuse old submissions as soon as registration commits. A provider call already claimed or in flight cannot be recalled; erasure does not assert remote deletion or turn an uncertain result into success.
6. Lifecycles travel in tenant export/import and full backups. Erasure-only snapshots retain their existing five-column append-only format: they carry every ended id and cutoff, not readmission exemptions. Restore remains offline until migrations, newer registers and apply finish. A newer register can invalidate a lifecycle in an older full backup; it cannot invent a new one.

## Rejected alternatives

- Permanent address blacklist: destroys explicit later consent.
- A cutoff on reception or occurrence time alone: delayed or replayed old sources gain permission.
- Reusing the erased supporter id: repeats the same erasure and rebuilds the new person from tombstones.
- Deleting the old registration: a restore revives the original copies and loses backup evidence.

## Consequences

Migration 0046 adds lifecycle evidence without rewriting old rows or migrations. The existing memory, erasure, ingest, portability and backup suites prove the boundary. The ordinary erasure route, durable worker scheduling, general retention and people/credit erasure remain separate work; this decision does not claim complete production erasure.
