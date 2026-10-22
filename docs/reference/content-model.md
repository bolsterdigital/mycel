# Content model

How pages and articles are stored, revised, published per locale and scheduled (TODO #8a). The decisions are in [ADR 012](../adr/012-content-types-and-publishing.md), [ADR 018](../adr/018-precise-editorial-operations.md) and [ADR 020](../adr/020-editing-surface-and-block-operations.md); this page records the choices made while building them, so #8b, #8c and #9 build on them instead of choosing again. Code: `packages/core/src/content/`, migration `0011_content_items_and_revisions.sql`, repositories in `packages/db/src/content.ts`.

## Item, revisions, locales

| Table                  | One row per             | Holds                                                                                                                                                            |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content_items`        | page or article         | id (UUIDv7), type (`page`, `article`, never changes), slug, latest revision id, title/locales of the latest revision for lists, created and updated time         |
| `content_revisions`    | save                    | the whole validated document (`ContentDocument`), the acting principal, the time. Never updated: `mycel_app` may only insert and select                          |
| `content_item_locales` | item and locale         | the live pointer (`published_revision_id`, `published_at`, `first_published_at`) and the scheduled pin (`scheduled_revision_id`, `scheduled_for`, `schedule_id`) |
| `authors`, `sections`  | author profile, section | tenant entities with their own slug space; an author's `email` is internal                                                                                       |
| `patterns`             | saved block tree        | localised name and description, intended type, blocks; applying one copies the blocks with new ids                                                               |

Every pointer is a composite foreign key on `(tenant_id, item_id, revision_id)`, so a locale can only point at a revision of its own item in its own tenant. All six tables have forced RLS and the `tenant_isolation` policy (ADR 002).

**Status is derived, per locale** (ADR 018 rule 9): `published` while a live pointer exists, `scheduled` while only a pin exists, `unpublished` once it has been live, `draft` before that. The column is generated in SQL and computed the same way by `statusOf` in `lifecycle.ts`. "Published with unpublished changes" is `hasUnpublishedChanges`: the latest revision is not the live one. There is no global status that switches all locales at once.

## Documents and blocks

A document is `{ type, title, defaultLocale, locales, blocks, seo, access }`; an article adds `lead`, ordered `authorIds`, `sectionId`, `tags`, `corrections` and `delivery`. Every localisable field is a `{ [locale]: value }` map on the same document (ADR 007), and a value for a locale the document does not list is refused.

- **Block ids** (ADR 020 rule 1): a string of `A-Z a-z 0-9 _ -`, at most 64 characters, unique in the whole document. A caller may omit the id of a new block and the core assigns a UUIDv7; ids that are sent are kept. At most 200 blocks per document. Two `rich-text` blocks are never adjacent in one block list.
- **Block set of #8a**: `heading`, `signup-form` (a form reference), `rich-text`, `paywall`. #8b adds the rest.
- **Rich text** (ADR 020 rule 2): ProseMirror JSON with `doc`, `paragraph`, `text`, `heading` (relative level 1 to 3; consecutive headings never skip a level), `bullet_list`, `ordered_list` (optional `start`), `list_item` (starts with a paragraph) and `hard_break`. Marks: `bold`, `italic`, `code`, `link` and `footnote_reference` (the note's text in its attributes). Lists nest at most three levels deep, at most 5000 nodes and 100 000 characters per locale. Every node and mark is a strict object: unknown nodes, marks or attributes are refused.
- **Links** carry exactly one target: `href` (http or https without credentials, `mailto:`, or a site path starting with a single `/`) or `itemId`, a content item of the same tenant. Internal links to content use `itemId`, so a later slug change (#9) cannot break them.

## Readiness and references

Drafts may miss translations. Publishing or scheduling a locale requires (`readinessIssues`):

- the locale is one of the document's;
- the title and every required visible field have a value in that locale (block text, rich text, an article's lead once it has one in any locale, corrections, the e-mail subject when `delivery.email` is set), with no fallback;
- an article has at least one author;
- a restricted article with the default `lead` teaser has a lead;
- `access.level: tier` fails closed until #19 can verify tier ids.

SEO overrides are optional per locale: absent means derived (title, lead), present must not be empty.

References are checked on every save and again at publication: forms, linked items, authors and the section must exist in the tenant. Lookups run under RLS, so another tenant's id is simply unknown; the error names the path, never whether the id exists elsewhere.

## Access and teaser

`access: { level: public | members | tier, tierIds?, teaser }` on pages and articles alike (ADR 016 rule 3, ADR 018 rule 6). `teaser` is `lead` (default), `marker` (exactly one `paywall` block at the top level of the tree) or `{ blocks: n }` (an integer from 0 up to the number of top-level blocks). A `paywall` block without the marker teaser is refused. Restricted content is never served by the current public route (`content.page.get`); #19 brings the reader session and the teaser projection.

## URLs, slugs and tags

- One slug per item, not localised in v1: lowercase ASCII, digits and hyphens, starting with a letter or digit, at most 63 characters. Unique per tenant and type (`unique (tenant_id, type, slug)`); authors and sections have their own slug spaces.
- Paths: pages at `/<slug>`, articles at `/articles/<slug>`, author and section archives at `/authors/<slug>` and `/sections/<slug>`, tags later at `/tags/<tag>`. A non-default locale is a prefix (`/en/...`); the default locale has none (ADR 007 rule 3). The page with slug `index` is the homepage. Absolute URLs come from `siteUrl` only; routing is #8c.
- **Reserved page slugs**: `admin`, `api`, `internal`, `v1`, `confirm`, `reader`, `articles`, `authors`, `sections`, `tags`, `assets`, `_app`, `healthz`, `thanks`, `robots.txt`, `favicon.ico`, and every string that parses as a locale (two or three lowercase letters, optionally `-XX`), so adding a locale later can never shadow a page. The list is `RESERVED_PAGE_SLUGS` in `model.ts` and is checked when a page is created.
- A slug is chosen at create and does not change on update. Renames with redirects are #9.
- **Tags** stay strings (ADR 012 rule 3). Their identity is the canonical form: Unicode NFC, trimmed, lowercase, runs of whitespace as one space; duplicates are dropped in input order. A canonical tag is letters and digits in words joined by single spaces or hyphens, at most 50 characters, at most 20 tags per article. No tag entity, id or rename in v1; stable term ids would need a successor to ADR 012 rule 3.

## Use cases

| Use case                                                             | Capability        | Notes                                                                                             |
| -------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `content.item.create`, `content.item.update`                         | `content:write`   | Update needs `baseRevisionId`; a stale base is a typed `conflict` with nothing written            |
| `content.item.get`, `list`, `revisions`, `diff`                      | `content:read`    | Editorial; lists are keyset pages, newest first; `diff` lists changed paths, blocks matched by id |
| `content.item.publish`, `unpublish`, `schedule`, `unschedule`        | `content:publish` | One locale each; `effect: publish`. A manual publish or unpublish cancels that locale's plan      |
| `content.item.insert`, `move`, `remove`, `set_props`, `split_insert` | `content:write`   | One block by id; each needs `baseRevisionId` and makes one revision (see below)                   |
| `content.item.find`                                                  | `content:read`    | By block type and/or reference, latest or `live`; keyset pages, newest first                      |
| `content.author.*`, `content.section.*`, `content.pattern.*`         | write / read      | create, update, get, list                                                                         |
| `content.page.get`                                                   | `content:read`    | The public projection: one published locale of a public page, chosen among published locales only |

Every editorial use case is `authenticatedOnly`: an anonymous principal is refused whatever capabilities it holds, so a public visitor's `content:read` opens nothing but `content.page.get`. The registry rules require the flag for every `content.item.*`, `content.author.*`, `content.section.*` and `content.pattern.*` use case.

Every write takes the item lock (`select ... for update` on the item row) first. Two saves on one base therefore end in one new revision and one `conflict`, and a publication change racing a save or a scheduled job serialises in lock order.

## Block operations and references

Five commands edit one block without sending the whole document (ADR 020 rule 6). Each takes `itemId` and `baseRevisionId`, runs the same path as `content.item.update` (item lock, base check, full document validation, reference checks, block switches, one attributed revision) and returns `{ item, revision, created, retired, merged }`:

| Use case                    | Input besides item and base                                   | Effect                                                                                                                           |
| --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `content.item.insert`       | `block`, `place`                                              | A new block; it keeps an id it was sent with if that id is free, otherwise it gets a new one                                     |
| `content.item.move`         | `blockId`, `place`                                            | Same id at the new place, then normalise                                                                                         |
| `content.item.remove`       | `blockId`                                                     | The id is retired, then normalise                                                                                                |
| `content.item.set_props`    | `blockId`, `props`                                            | The complete props of that block's type; id and type stay. A locale left out of a localised field is removed from it             |
| `content.item.split_insert` | `blockId` (a `rich-text`), `at: { [locale]: index }`, `block` | Splits every locale of the text before `content[index]` and puts `block` between; the first part keeps the id, the second is new |

`place` is `{ before: id }`, `{ after: id }` or `{ at: 'start' | 'end' }`. Ids, never array indexes. An unknown `blockId` or anchor is `invalid_input` on that field (`content.block.unknown:<id>`), never `not_found`: the item exists, the request does not fit it. A stale base is `conflict` with nothing written.

- **Normalisation** (ADR 020 rule 4): after a move or remove, adjacent `rich-text` blocks merge into the first one; per locale the ProseMirror `content` arrays are concatenated, so marks, attributes and headings stay. Two blocks without the same set of locales do not merge: the operation fails with `content.blocks.merge-ambiguous:<id>` instead of losing or inventing a translation. `merged` lists `{ from, into }`, `retired` the removed and merged-away ids. Insert and `set_props` never normalise; an insert next to a `rich-text` is refused as `content.blocks.adjacent-rich-text`, as an update is.
- **Split-and-insert**: `at` names every locale the block has (`content.split.locale-missing`, `content.split.locale-unknown`), and both halves keep at least one node (`content.split.empty-part`). A `rich-text` block as the inserted block is refused, because the result would be adjacent text.
- **Block switches**: every block type in a saved document or pattern must be on in the site's entitlements (`blocks.<type>`); a switched-off type is `limit_exceeded` with `entitlements.feature_off` on create, update, every block operation and pattern create/update.

`content_block_refs (tenant_id, item_id, revision_id, block_id, type, ref_id)` (migration 0017) records every structured reference of every revision: `form` (signup blocks), `item` (link marks with `itemId`, anywhere in a rich-text tree), `media` (none until the `image` block of #8b2) per block, and `author` and `section` with a null `block_id`. The content repository writes the rows from `documentReferences` whenever it inserts a revision, so no caller can forget them; like revisions they are immutable for `mycel_app`. In the same transaction the save calls `ctx.media.replaceUsages('item:<itemId>:rev:<revisionId>', ...)` with the document's media blocks (an empty list for now). Migration 0017 backfilled every existing revision per tenant; `packages/db/src/content-refs-migration.conformance.test.ts` replays that block.

`content.item.find({ blockType?, ref?: { type, id }, live?, type?, after?, limit? })` needs at least one of `blockType` and `ref` and returns `{ items, matches: [{ itemId, blockIds }], next }`. Without `live` it searches each item's latest revision; with `live: true` only revisions that a locale publishes (`published_revision_id`), never drafts or history. `blockIds` are the blocks that matched (of the type, or carrying the reference); a document-level reference matches no block. The block-type filter is a containment query served by a GIN `jsonb_path_ops` index on `content_revisions.document`. `ContentRepository.liveReferences({ type, id })` counts the items whose published revision in any locale uses a reference: the hook for refusing to delete something live (ADR 004 rule 6). Both run under RLS, so another tenant's id finds nothing.

## Scheduled publishing

`content.item.schedule({ itemId, revisionId, locale, at })` accepts a future time with an offset, checks readiness and references, writes the pin with a new `scheduleId` and plans a `content.publish` job in the same transaction. The job key is `content.publish:<itemId>:<locale>:<scheduleId>`: a reschedule or a second locale never collides with an open job of an older plan, and `mycel_app` needs no right to cancel jobs.

The handler (`publishScheduled`) locks the item and compares the job with the current pin. A cancelled, replaced or already executed plan is a successful no-op; an early run returns `{ next: scheduledFor }`; a suspended site returns `{ next: +1 day }` with the pin kept (ADR 015 rule 7, `requireActive`). Otherwise it checks readiness and references again and puts exactly the pinned revision live, clearing the pin in the same transaction. A failed check throws, so the worker's retry and exhaustion route applies and what is live stays live.

## Migration of the probe's pages

Migration 0011 converts every row of `pages` in SQL, once, inside the migration's transaction: same id, slug and times, a first revision (actor `system`, job `migration:0011`), block ids `md5(<page id>:<position>)` as a UUID (the same input always converts to the same ids), and a publication only for the locales in which the title and every heading have a value. Each row is validated against the shape the core accepts (block types, versions, props, locales, form references in the same tenant); a row that does not fit stops the migration with its page id and reason, and nothing is kept. The tenant context is set per tenant, so the conversion runs as a non-superuser owner under forced RLS. `pages` is dropped at the end. `packages/db/src/content-migration.conformance.test.ts` replays the conversion block of the migration file.

## Not here yet

Blocks inside other blocks (the operations address one flat list until a container block exists); the remaining blocks, variants and theme #8b2; the renderers, locale routing, the read route with `ETag` and the block conformance suite #8c; SEO output, feeds and redirects #9; the editor #11; reader access #19. The public web route renders `rich-text` and `paywall` as nothing until #8c.
