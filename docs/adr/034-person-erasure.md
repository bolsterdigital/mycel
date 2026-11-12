# ADR 034 - A person is erased by explicit id; a name beside an erased id is scrubbed everywhere

- **Status**: accepted
- **Date**: 2026-11-12
- **Refines**: ADR 031 rules 2 and 6 (people register; erasure was left to a separate step)
- **Supersedes**: ADR 012 rule 4 and ADR 028 rules 1 and 3 only for the one targeted scrub in rule 4 below; revisions and plans stay immutable for every other purpose
- **Preserves**: ADR 002 tenant isolation, ADR 019 rule 8 every-copy and backup obligations, ADR 032 for supporters, ADR 018 rule 5 (as amended) for the `erase` effect

## Context

The people register (ADR 031) holds writers, image makers and team members: name, internal and public contact data, bio, role, organisation, links, portrait and group memberships. Nothing removes a person yet. A person is not a supporter: the model has no relation between a supporter id and a person id, and a name, slug or similar credit is no evidence that two records are the same human.

A person id is referenced from current and historical revisions (`authorIds`, people-grid blocks, credit overrides), patterns, bulk plan candidates and changes, `content_block_refs`, group memberships and media credits. A credit stores both `photographerPersonId` and a free-text `photographer`; the public renderer falls back to the free text when the person cannot be resolved, so deleting the person alone would publish the old name again. Revisions and plans are immutable (ADR 012 rule 4, ADR 028), so that free-text copy survives in history, exports and the editor's revision view.

## Decision

1. **A person erasure names explicit person ids.** `content.person.erase` takes one or more ids of the tenant's people register, carries effect `erase` and therefore requires `supporters:erase` (one effect, one capability; ADR 018 rule 5 as amended). A suspended tenant accepts it, as for supporters (ADR 015 rule 7 as amended). The system never derives a person from a supporter, an address, a name, a slug or a credit text; a request about a human who is both supporter and person is two explicit requests, linked by the operator.
2. **An append-only person register makes the erasure durable.** Each request appends `(tenant_id, person_id, erased_at, actor)` with forced RLS; the actor is kind and id as on `erasures`, never an address. A second request for a registered id is a no-op. The register travels in tenant export/import and in erasure snapshots as a set of its own beside the supporter register, whose five-column format (ADR 032 rule 6) stays unchanged. After a restore or import, apply erases every registered person id again before the tenant is back online.
3. **Apply removes the person and keeps the id as an inert reference.** The `people` row and its `person_group_members` rows are deleted. Ids in documents, revisions, patterns, plans, `content_block_refs` and media credits remain: without the row they identify nobody, and keeping them avoids rewriting attribution structure. A removed or registered id resolves as absent everywhere: no byline, no profile (the same 404 as an unknown person, ADR 031 rule 5), no grid card, no credit name, no link. The slug becomes free. The portrait and other images are media assets with their own route (`media.delete`); the erasure does not delete pixels, because a face or a photograph is not found from a person id, and a shared asset may show others.
4. **Targeted scrub of the name beside an erased id.** In every stored JSON copy of editorial data (current and historical revisions, trashed items, patterns, bulk plan candidates and change values, media credits), a credit object whose `photographerPersonId` is a registered id gets `photographer` set to null; a plan change value at that credit's `photographer` path is nulled likewise. Nothing else in the copy changes: ids, text, structure and revision ids stay, so diff, provenance, undo and the publication pointer keep working. This is the only in-place change to a revision or plan this ADR allows. It is repeatable, so apply after a restore converges on the same result. The renderer never falls back to the free text of a credit whose person id is absent.
5. **Representations and copies follow the same register.** Public representations (HTML, the JSON read route, feeds, sitemaps, structured data, profile pages) resolve people at read time and derive their ETag from the rendered result, so after apply they stop carrying the person within the ordinary cache lifetime (ADR 018 rule 8); a later server-side or CDN cache keyed on a revision must be purged by apply for every item that references a registered id. Export archives that may hold the person expire as for supporter erasures. Every catalog copy with subject `person` (`STORAGE`, `OFF_TABLE_STORAGE`) gets a real route; a copy no route can reach (free-text names inside prose, pixels) is listed with that reason and its ordinary tenant route instead of being claimed erased.
6. **Names in arbitrary text are not erased by this request.** A person mentioned in prose, a caption, a pattern name or a free-text credit without a person id is not found from a person id. The tenant edits current text through ordinary use cases; older revisions keep such text. The erasure result says so explicitly rather than reporting "all erased".

## Rejected alternatives

- Linking a supporter erasure to people by name, slug or address: a guessed match erases the wrong human or misses the right one.
- A tombstone row in `people`: keeps a record that only exists to say someone was there; an absent row with an inert id gives the same rendering and holds nothing.
- Removing person ids from documents and revisions: rewrites attribution structure and every revision for no privacy gain once the row is gone.
- Leaving revisions untouched and hiding the free-text name only at render: the name stays in exports, the revision view and backups.
- A new capability `people:erase`: one irreversible effect would need two capabilities, and an audit migration for a second erase effect, while the legal duty is the same.
- Deleting the portrait asset with the person: a shared asset may show others, and pixels are not evidence of identity.

## Consequences

A migration adds the person register with forced RLS and grants for the erasure role; its number is claimed at build. `content.person.erase` joins the registry, HTTP and MCP like every use case. `apply` gains a person phase under the same per-tenant run; the existing supporter phase is unchanged. `STORAGE` replaces each `planned: people` route with the route above or an explicit reason, and the `people` open-work key disappears. People/public, block, erasure, export and RLS conformance grow: the same person as author and photographer in nl/en, current/historical/trash/pattern/plan copies, free-text fallback, a second person and another tenant untouched, profile/credit/cache/export before and after apply, and restore. Operator accounts remain separate work (#224).
