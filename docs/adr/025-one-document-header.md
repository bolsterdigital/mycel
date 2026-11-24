# ADR 025 - One document header above the blocks; legacy hero blocks stay valid

- **Status**: accepted
- **Date**: 2026-11-01
- **Rules 1 and 3 partly superseded**: 2026-11-22 by [ADR 038](038-campaign-presentation.md), for landing pages bound to a campaign (header image first; a second, fixed page header layout chosen by the binding).
- **Rule 3 amended**: 2026-11-23, pages get `cover` and `split` (MY-287), see [Amendment](#amendment-2026-11-23-page-headers).
- **Refines**: ADR 004 rules 1 and 5 (document metadata, versioned block schemas), ADR 012 rule 1 (page and article fields), ADR 020 rules 1 and 6 (stable ids, revisioned operations)
- **Builds on**: ADR 007 (localisation), ADR 009 (one registry, HTML first), ADR 018 (revisions, baseRevisionId, separate publish capability)

## Context

Since #86 every page and article has a title, a lead and a hero image as document fields, rendered between the site header and the blocks. The block set also has a `hero` type (title, body, image, up to two actions), and the demo pages and one pattern open with one. A page that has both shows two headers, and editors cannot tell which one is "the" title. Editors asked for one header and an image block without a call-to-action overlay (MY-110, 2026-10-31). The hero type cannot simply be dropped: stored revisions contain it, and ADR 004 and 020 promise that valid blocks, ids, locales and props survive.

## Decision

1. **The document header is metadata, not a block.** It is the document's `title`, `lead`, `heroImageId` and `heroAlt`, rendered once, above the block tree, in that reading order; the title is the page's only `h1` (ADR 004 rule 3). Saving, the API, MCP, preview, export and readiness all use these fields of the one canonical document; no editor keeps a header of its own.
2. **The hero image's alt belongs to the document, per locale.** `heroAlt` is optional; absent means decorative, as before. Present, it is a non-empty localised map, only next to a `heroImageId`, and readiness requires it in every published locale like any visible field. The featured and share image still carry no alt of their own (#86).
3. **How the header looks is a closed choice.** Pages have one header layout. Articles may carry `presentation.header` (`standard` or `cover`, absent reads as `standard`); a page refuses the field. Further layouts are registry data under ADR 013, never free composition.
4. **The `hero` block stays a registered, versioned type.** Existing documents keep reading, editing, rendering and exporting their hero blocks unchanged. New content does not get one: the hero leaves the insertion choices and the shipped patterns, which is presentation of the registry, not a schema change. Removing the type would need a superseding ADR and a lossless conversion of every stored revision.
5. **Moving a hero into the header is an explicit, per-document conversion.** An editor (or an agent through the same use case) is shown the source block and the target fields, and only a deliberate save writes a new draft revision with `baseRevisionId`; publishing stays a separate act and capability (ADR 018). The conversion applies only when the header fields are empty or equal to the hero's values. Anything else (different title, lead or image, more than one hero, a hero after other blocks) is a conflict: nothing is written and the block stays fully editable. Hero actions are never attached to an image or dropped; they become a separate `cta` block at the hero's position. The result reports the retired hero id and every created id, and keeps every locale, reference, caption and credit.
6. **No revision is rewritten.** Published, scheduled and older revisions and sent editions keep their hero blocks. There is no tenant-wide or SQL migration; a document converts when someone edits it.

## Rejected alternatives

- **Removing `hero` from the registry**: old revisions stop parsing, which ADR 004 rule 5 and ADR 020 rule 1 forbid.
- **Converting on read or on any save**: a silent change to content the editor did not touch, and a heuristic choice whenever the header and the hero disagree.
- **The header as a mandatory first block**: two places for the title (block and document), heading rules per position, and a block that cannot be moved or removed like the others.
- **A batch migration per tenant**: rewrites history and cannot ask about conflicts.

## Consequences

- #99 (hero alt), #105 (article header layouts) and MY-110 B (header group, picker, conversion) build against this ADR; each keeps its own acceptance evidence.
- The conversion changes stored content and is reviewed as a data-loss risk (`flagship-review`); the alt, the layouts and the picker change are ordinary changes.
- A future change of the header fields is a document schema change and follows ADR 004 rule 5: forward conversion, never defaults written into old revisions.

## Amendment 2026-11-23: page headers

Rebuilding two Dreamkit sites in Mycel (MY-268) showed that a page needs more than one header: Frisse Wind opens its home page with a full-screen photo, BIJ1 Rotterdam with a header of two halves, a dark panel with title, lead and a "join" button beside a portrait. The owner chose `cover` for pages too and named the split header as a missing difference (2026-11-22). Rule 3 now reads:

3. **How the header looks is a closed choice.** Articles may carry `presentation.header` (`standard` or `cover`); pages may carry `presentation.header` (`standard`, `cover` or `split`). Absent reads as `standard` for both, so no stored revision changes. `split` puts the title, the lead (and an event's when and where) and at most one button in a panel on the theme's validated `accent` pair, the hero image beside it; in a narrow container the image stands under the panel. The button is `presentation.action`, the same shape as a hero block's action (a label per locale, required in every published locale, and a target that is an item of the tenant or a safe URL); it exists only beside `split`. An item target is checked on every save and publish like a block's; it gets no `content_block_refs` row, because that row belongs to a block, so a target that is unpublished or deleted later renders no button, as a navigation target does (ADR 036). Without a hero image `cover` and `split` render as `standard`. A campaign landing page keeps the layout its binding chooses (ADR 038). Further layouts are registry data under ADR 013, never free composition.

Rejected: `split` for articles (an article's meta line and byline have no place in the panel), a panel colour per page (free styling outside the theme, ADR 013), and keeping the BIJ1 header as a `hero` block (rule 4: new content gets the document header).

## Amendment 2026-11-24: article profiles

New articles start with an explicit Post presentation. An article revision may select Post or Longread and keep independent header, author, reading-time and initial overrides for each profile. Each setting and the active profile merge separately under ADR 026. Changing profile preserves the other profile's settings. Clearing an override restores its profile default. Reading, saving, scheduling and restoring an existing revision without a profile preserve its header and site initial behaviour until an editor selects a profile and publishes that revision.

Post uses a compact image, inline author names, reading time and an ordinary initial. Longread uses a cover when an image is available, author portraits where available, reading time and a measured initial when the site permits it. A compact opening uses a centred 3:2 image on desktop bounded by 45vh and 45rem, and 16:9 on mobile. Compute reading time from the lead and visible editorial text in the served locale at 200 words per minute, rounded up, with no estimate for zero words. Both previews follow the same projection as the public article.
