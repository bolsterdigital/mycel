# ADR 026 - A save on an older revision merges; only a value both changed is a conflict

- **Status**: accepted
- **Date**: 2026-11-06
- **Refines**: ADR 018 rule 2 (optimistic concurrency), ADR 020 rule 6 (revisioned block operations)
- **Builds on**: ADR 007 (localisation), ADR 009 (one registry for every front, HTML first), ADR 020 rules 1 and 4 (stable block ids, canonical text blocks), ADR 021 (provenance of a revision)

## Context

ADR 018 rule 2 makes every save carry `baseRevisionId` and refuses a stale one with `conflict`. That stops a silent lost update, but it moves the loss to the second save: the form comes back with what the editor typed, a table of everything that changed, and a save that puts the whole form over the newest revision. When an agent changed block 3 and the editor block 7, the editor's second save writes block 3 back unless they read the table carefully. The revision stays in the history; the change is gone from the document. Editors seldom write the same item at the same moment, but agents make concurrent writes ordinary (twenty articles with a new call to action in one run). Locks are not an answer: nothing may block someone else, and a lock left behind by a closed browser is the WordPress experience this project avoids.

## Decision

1. **A save on an older base is a three-way merge.** `content.item.update` with a `baseRevisionId` that is not the latest combines three documents: the base, the caller's document and the latest revision. What only one side changed is taken; what both changed to the same value is taken once; only a value both changed differently is a conflict. A save on the latest revision is unchanged: there is nothing to merge. The base must be a revision of the item; any other id is the stale-base `conflict` of ADR 018.

2. **The unit of a merge is a document field, a locale and a block id.** Objects merge key by key, so `title.nl` and `title.en` are separate values, as are two props of one block. Lists whose items have an `id` (the block tree at every depth) merge per id: a block one side removed and the other left alone is removed; removed by one and changed by the other is a conflict. The order of such a list is one value: both reordering differently is a conflict, and a block one side added follows its predecessor on that side. Every other list (authors, tags, corrections, locales) is one value.

3. **Text inside one rich-text block does not merge.** A rich-text document in one locale is one value, so two people in one block's text get a choice between the versions. An article is often one large text block, so this conflict stays common there; merging at paragraph level needs a paragraph identity the schema does not have and is a later decision when the signal comes.

4. **A merge is never silent and never half.** The merged revision records `provenance: { merged: { baseRevisionId, latestRevisionId } }`, and the admin says with whose save it merged. The merged document passes the same full validation as any save. When the combination breaks a rule of the whole document that neither side broke alone (two text blocks side by side, ADR 020 rule 4), the block list becomes the one conflict, and when that does not explain it, the whole document. Nothing is written while a conflict is open.

5. **A conflict names each value.** The typed `conflict` carries the issue `baseRevisionId` (`content.revision.conflict`, with `params.latestRevisionId`) and one issue per conflicting value (`content.revision.conflict-value`) at `document.<path>`, in the path grammar of `content.revision.diff` (`document.blocks[id=x].props.text.nl`, `document.blocks#order`). HTTP returns these issues in its Problem Details as MCP does in its tool error. A caller resolves by reading the latest revision and saving again on it.

6. **The edit screen asks only about those values.** After a conflict the form comes back on the newest revision with the merge filled in: the other side's changes taken, the editor's kept. One choice per conflicting value is shown, "keep mine" (checked, as the form shows it) or "use theirs", and is posted with the form, so it works without JavaScript and with any button of the form. The writer's document is rebuilt from the same proposal, so its next save never refers to a block the newest revision does not know.

7. **Block operations stay strict until they are rebased.** The id-addressed operations of ADR 020 rule 6 keep requiring the latest revision. Rebasing them onto the latest revision when their target and anchor did not change, and a base check on authors and sections, are the next step under this ADR; a bulk contract for agents builds on both. Realtime editing stays declined (A6); autosave, if it comes, follows rules 1 to 4.

## Rejected alternatives

- **Last-write-wins, or "save again to put yours on top"**: the second form undoes changes its editor did not read, which is how ADR 018's refusal still lost work.
- **A lock per item**: blocks others, and a lock that outlives its owner needs a takeover, the experience this decision exists to avoid.
- **A CRDT or operational transform**: needs every keystroke from every client, which only realtime editing provides, and adds a dependency (ADR 008) for a case editors meet rarely.
- **Merging inside rich text by paragraph index**: an insertion shifts every later paragraph, so an index merge would combine unrelated edits; there is no stable paragraph id.
- **A per-front merge**: an agent would get a different rule from an editor (ADR 009); the merge is core's, the fronts present it.

## Consequences

- `content.item.update` merges in core (`content/merge/merge.ts`, `mergeSave`); its conformance runs in memory, against Postgres under the item lock (eight concurrent saves on different blocks lose nothing) and over HTTP and MCP with the same authorization.
- `Revision.provenance` is either an assist suggestion (ADR 021) or a merge; the column stays one `jsonb`.
- The edit screen's conflict notice (`ConflictNotice`) replaces the difference table for saves; the table remains for refusals that have no posted document to merge.
- Rebasing block operations and the entity base check are delivered separately against rule 7, each with its own evidence.
