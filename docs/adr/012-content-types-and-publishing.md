# ADR 012 - Content types, authors, publishing lifecycle and the read route

- **Status**: accepted
- **Date**: 2026-10-21
- **Builds on**: ADR 004 (block tree), ADR 007 (i18n), ADR 009 rule 9 (versioned mutations)
- **Amended**: 2026-10-21 by ADR 018 (scheduled publish pins a revision, optimistic concurrency, immutable sent editions, per-locale status, access-aware caching on the read route)
- **Rule 2 amended**: 2026-10-28. An article has zero or more authors; without authors the renderer shows no byline. Requiring an author blocked publishing on sites that never sign their articles (editor trial of 2026-10-28, decision of the maintainer). The original wording was "An article has one or more authors".
- **Rule 1 amended**: 2026-10-29. Both types carry an optional `featuredImageId`, the item's own image, and the share image `seo.imageId` falls back to it. It is a media reference with the same invariants as an image block (ADR 004 rule 6: checked at every save and publish, a recorded usage, a delete refused while used). Without it a share preview showed no image unless an editor filled a separate SEO field, and article cards (#47A) had nothing to show (TODO #66, decision of the maintainer). The original wording is retained below.
- **Rule 6 superseded**: 2026-10-22 by [ADR 020](020-editing-surface-and-block-operations.md) (relative headings in prose, quotations as cards and the editing contract). Only rule 6 is superseded; its original wording is retained below.
- **Rule 1 extension allowance partly superseded**: 2026-10-24 by [ADR 022](022-managed-extensions-and-site-integrations.md). An additional editorial shape that fits the model is a type profile over `page` or `article`, not an ADR-free third stored type; a new domain entity or lifecycle requires an ADR. The two stored content types and publication invariants remain in force.

## Context

Mycel serves campaigns and independent journalism from day one. Both publish a block tree, but a news article carries metadata a landing page does not (publication date, authors, section, corrections), has a lifecycle (draft, scheduled, published, updated) and is often also an e-mail: a newsletter issue is an article that was sent. Ghost and Substack model this as "posts" with an e-mail switch; Dreamkit had pages only and bolted news on with WordPress posts. These shapes leak into the schema, the URL space, the API and the e-mail renderer, so they are decided now, before the block set is built.

## Decision

1. **Two content types share one block tree model: `page` and `article`.** Both are `{ metadata, blocks }` documents validated by Zod (ADR 004). `page` is navigational and timeless. `article` adds: `publishedAt`, `updatedAt`, `lead` (localised), `section` (one, optional), `tags`, `authors` (ordered list of author ids), `access` (ADR 016), `corrections` (dated, localised notes rendered on the article), `delivery` (see rule 5). Further types (event, dossier) are later ADR-free registry entries only if they fit this shape; otherwise a new ADR.
2. **Authors are an entity** (`authors`: name, slug, localised bio, image, links, `email` optional), tenant-owned, with an archive page per author. An article has zero or more authors (amended 2026-10-28; none means no byline); an author may be a person without an operator account. Operators link to an author profile; they are not the same record.
3. **Sections are an entity** (`sections`: slug, localised title and description, order), with an archive page and a feed each. Tags are free strings per tenant, no entity.
4. **Lifecycle is a status plus revisions, not two tables.** `status: draft | scheduled | published | unpublished`; `scheduledFor` for scheduled items; every save creates a revision row with the full document and the acting principal; publishing pins `publishedRevision`. The public renderer reads only the published revision; preview reads the latest. Diff is computed from two revisions (ADR 009 rule 9). Scheduled publishing is executed by the background worker from a `jobs` table (same claim pattern as the outbox, ADR 011).
5. **A newsletter issue is an article with `delivery.email`.** `delivery: { web: boolean, email?: { listId, subject, sentAt?, campaignId? } }`. Sending creates a mailing campaign (ADR 010) that renders the same block tree with the e-mail renderer; the web version is the online archive and the "read in browser" link. There is no second content model for e-mails; mail-only templates (transactional) are mailing-domain data.
6. **Rich text inside a block is a constrained ProseMirror document.** The `rich-text` block's `content` is a JSON node tree with a fixed, versioned schema (paragraph, bullet and ordered list, blockquote, hard break; marks: bold, italic, link, code, footnote reference). No headings, images or embeds inside rich text: those are blocks. The admin editor is TipTap (MIT) configured to exactly this schema; renderers (HTML, Markdown, e-mail, native) walk the tree. Zod validates the tree on write.
7. **Published content has a cached, versioned read route separate from the use-case routes.** `GET /v1/sites/{tenant}/content/{type}/{slug}?locale=` and the list routes (section, author, tag, feed) return the published revision as JSON with `ETag` and `Cache-Control`, no authentication for public items, reader session for restricted ones (ADR 016). This is the contract a PWA, a native app or a static exporter reads; it never exposes drafts. The HTML renderer in `apps/web` uses the same query functions.
8. **Patterns are stored block trees** (`patterns`: name, description, blocks, intended type) that seed a new document. Long-read and photo-story ship as default patterns; tenants may save their own. Patterns are data, never code.

## Rejected alternatives

- **One `post` type with a `kind` flag**: fewer tables, but every page would carry nullable article fields and every article query would filter on kind. Two types with one block model is the Ghost lesson applied without its ambiguity.
- **Separate `newsletters` content type**: how Substack grew; it forces a second editor and archive. An article that is also sent covers the use case; mail-only content is a mailing template.
- **Markdown for rich text**: readable, but tables, footnotes and links with attributes need extensions, and the editor round-trip loses structure. ProseMirror JSON is the format TipTap already speaks and is trivially validated.
- **Portable Text**: close, but it is Sanity's dialect with less tooling for an editor we would need anyway.
- **Draft and published as two tables**: simpler reads, but preview, scheduling and diff all need history; revisions give all three.

## Consequences

- Tables in fase 1: `content_items` (type, slug, status, published_revision_id, scheduled_for), `content_revisions`, `authors`, `sections`, `patterns`, `jobs`; all tenant-owned with RLS. `pages` from the probe migrates into `content_items` with `type = 'page'`.
- Feeds (RSS/Atom per tenant, section and author), sitemap and `NewsArticle` structured data derive from the read route; they are not built yet.
- The e-mail renderer (fase 4) is the first consumer of rule 5; until then `delivery.email` is stored but not acted upon.
- Use-case names: `content.item.*` (create, update, publish, unpublish, schedule, revisions, diff), `content.author.*`, `content.section.*`, `content.pattern.*`.
