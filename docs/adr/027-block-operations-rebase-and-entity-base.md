# ADR 027 - A block operation on an older revision is rebased; authors and sections carry a base

- **Status**: accepted
- **Date**: 2026-11-07
- **Refines**: ADR 026 rule 7 (block operations stay strict until they are rebased), ADR 020 rule 6 (revisioned block operations), ADR 018 rule 2 (optimistic concurrency)
- **Builds on**: ADR 026 rules 4 and 5 (a merge is never silent; a conflict names each value), ADR 012 rules 2 and 3 (authors and sections are entities), ADR 009 (one registry for every front)

## Context

ADR 026 made a whole-document save on an older base a three-way merge and left two gaps for a next step (its rule 7). The block operations of ADR 020 rule 6 (insert, move, remove, update, split-and-insert) still refused any older base, so an agent that adds a call to action after reading an article fails the moment an editor saves an unrelated block, and the edit screen's block actions fail the same way from a screen opened before someone else's save. And `content.author.update` and `content.section.update` were last-write-wins: a bulk change of authors would overwrite an editor's correction to a bio without either side knowing. Agents make both ordinary.

## Decision

1. **A block operation on an older base is applied to the newest revision when its footing did not change.** Its footing is what it relies on: the block it addresses (update, remove, split-and-insert, move), and for a placement the place between two blocks where a block lands, named by the ids on either side (null at an end of the list), together with those blocks; for a move also the place the block leaves. When every block of the footing is the same in the base and the newest revision, and every place is still the same pair of blocks, the operation is applied to the newest revision and validated as a whole document like any save. Its result's `created`, `retired` and `merged` refer to that revision.

2. **A rebased operation is never silent.** The revision records `provenance: { merged: { baseRevisionId, latestRevisionId } }`, the form ADR 026 rule 4 gave a merged save, so the API, MCP and the edit screen read one signal. The edit screen treats a rebased block action as it treats a save that merged: it says with whose save, and an action that puts a revision live, on a schedule or approves it is not taken in the same click.

3. **Otherwise it is a conflict that names what moved.** The typed `conflict` carries the issue `baseRevisionId` (`content.revision.conflict`) and one `content.revision.conflict-value` per block of the footing that changed or is gone (`document.blocks[id=x]`) and, when a place is no longer the same pair, the order (`document.blocks#order`), in the path grammar of ADR 026 rule 5. Nothing is written. The caller reads the newest revision and tries again on it. A base that is no revision of the item stays the stale-base conflict of ADR 018.

4. **A block is one value for an operation, unlike for a save.** A save merges a block per prop (ADR 026 rule 2), so a hero image replaced on one side and the old image's alt corrected on the other give the new image with the corrected alt; values that belong together merge apart there, and a reviewer of a merged revision sees that combination in its history. An operation does not merge into a block: a props update replaces the props it was sent, so it is only rebased when no prop of the block changed since. The same holds for its neighbours at a placement: an insert after a block someone rewrote may no longer belong there.

5. **Authors and sections are updated on a base.** `content.author.update` and `content.section.update` take `baseUpdatedAt`, the `updatedAt` the caller read, and fail with `conflict` (issue `baseUpdatedAt`, `content.entity.conflict`, `params.updatedAt` of the stored record) when the record changed since. The write itself is a compare-and-set on that stamp, so of two updates on one base exactly one is written. Every write moves the stamp strictly forward (at least one millisecond past the base), so two writes can never carry the same stamp.

## Rejected alternatives

- **Rebasing through the three-way merge of a save**: an operation would merge into a block whose other props it never read and land next to a block that was rewritten, which is a combination neither side chose; rule 4 keeps that to whole-document saves, whose author saw the whole form.
- **Keeping operations strict**: every agent edit fails on an unrelated save, and a bulk run of twenty items fails on most of them while editors work.
- **A version column on authors and sections**: a migration and a second stamp for what `updatedAt` already says once every write moves it forward.
- **An optional base on entity updates**: a caller that leaves it out keeps last-write-wins, which is what rule 5 removes.

## Consequences

- `mutate` in `content/operations.ts` applies an operation to the base (an operation that does not fit the document it was read from is `invalid_input`), checks its footing against the newest revision under the item lock and applies it again there; in-memory tests cover each operation rebased and refused, Postgres covers eight concurrent operations on different blocks (all land) and on one block (one lands), and HTTP and MCP run the same scenario with the same authorization.
- The edit screen counts a rebased block action as a merge (`noteRebase` in `edit-path.ts`); its notices and the held publication are those of ADR 026.
- `baseUpdatedAt` is a required input of both entity updates: a breaking change of their HTTP and MCP contract. The admin has no form for authors or sections yet; one that comes carries the stamp it read and shows the conflict with when, as the item form does.
- The audit row of a rebased operation is the ordinary `ok` row of its command; the revision's provenance is where the rebase is recorded (ADR 019 rule 8: the audit names who did what, not the content).
- The bulk contract for agents builds on this: a rebased item counts as done, a conflicting one is reported per item.
