# ADR 030 - Deleting content moves it to a trash

- **Status**: accepted
- **Date**: 2026-11-08
- **Builds on**: ADR 004 rule 6 (references), ADR 012 (content lifecycle), ADR 018 (precise operations)

## Context

A page or article could only be taken offline. Deleting for good cannot be undone, the keys that point at an item do not cascade, and a sent newsletter or a linked page must not disappear by accident.

## Decision

1. `content.item.delete` moves an item to the trash: `deleted_at` is set, and every revision, publication row and reference stays. There is no automatic purge and no permanent delete; erasing for good is a separate decision (ADR 019 for personal data).
2. An item in the trash does not exist for every other operation: the repository's reads and locks leave it out, so public routes, lists, the editor, the API and MCP answer as for an unknown id. Only `content.trash.list` and `content.item.restore` see it.
3. Deleting takes every locale offline, drops its planning and answers offers for publication, in the one transaction under the item lock. Restoring never publishes: an item comes back offline or as a draft, whatever it was.
4. An item that another item links to, in its latest or in a published revision, cannot be deleted: the refusal counts and names them, as a used form or file is refused (ADR 004 rule 6).
5. The slug is free while an item is in the trash. A restore gets its old slug back when it is free, otherwise the first free `-2` variant, and reports that the address changed.
6. Delete, restore and the trash list require `content:publish`. The effect on the public site is that of taking offline, and a restore publishes nothing.
7. A trashed item is exported and imported with its `deleted_at`: an archive is complete.

## Rejected alternatives

- A separate capability `content:delete`: roles are derived from exact capability sets, so every stored editor set would become `custom`, or a migration would silently widen existing API keys.
- Keeping a publication across the trash: a restore would put old content live without anyone choosing that.
- Renaming the slug on delete, or a separate trash table: see migration 0039.
- A retention window with a purge, as for media: media frees storage and has no incoming keys. Content has both the keys and the risk.

## Consequences

Trashed items keep their media usages, so a file used only by a trashed item stays undeletable until the item is restored and edited. A link added to an item at the same moment that item is deleted is not caught by rule 4; it then behaves as a link to an unpublished item. Bulk delete is not part of this: ADR 028's operations are closed and need their own decision.
