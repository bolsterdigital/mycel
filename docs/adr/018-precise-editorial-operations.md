# ADR 018 - Publishing, sending and access are precise operations

- **Status**: accepted
- **Date**: 2026-10-21
- **Amends**: ADR 012 (rules 4, 5 and 7), ADR 016 (rule 3)
- **Prompted by**: second-opinion review of 2026-10-21, findings 2 and 3 and the product table

## Context

ADR 012 pins `publishedRevision` at publish time but says nothing about which revision a _scheduled_ publication uses, what happens when two people save the same item, or whether a sent newsletter can change after sending. ADR 016 defines the teaser as "the first two blocks", and one `rich-text` block can hold a whole article, so a text-only article would leak completely. These are design risks, not bugs yet; they become bugs the moment #8, #11, #15 and #19 are built against the current wording.

## Decision

1. **A scheduled publication pins a revision.** `content.item.schedule(itemId, revisionId, at)` stores the revision id in the job payload; the worker publishes exactly that revision. Saving a newer revision after scheduling does not change what will appear; the admin shows "revision 4 goes live at 09:00, you are editing revision 5" and offers to re-pin. Unscheduling and re-scheduling are explicit use cases.
2. **Saves are optimistically concurrent.** `content.item.update` carries `baseRevisionId`; if the item's latest revision differs, the use case fails with typed error `conflict` and the fronts show both versions. Autosave in the admin uses the same rule. No last-write-wins.
3. **A published item stays visible while an update is prepared.** Editing a published item creates draft revisions; the public read route serves `publishedRevision` until `publish` pins a newer one. "Published with unpublished changes" is a visible state in the admin.
4. **A sent newsletter is an immutable edition.** `mailing.send` snapshots the rendered content (e-mail HTML, text part), subject, locale and list at send time into the campaign; recipients within one send receive identical mail. A later web correction does not change the archive copy of the sent edition; "send a correction" is a new campaign that references the first. The web article remains the live, correctable version (ADR 012 rule 5).
5. **Capabilities separate writing, publishing, sending and exporting.** Minimum set per tenant membership and API key: `content:write`, `content:publish`, `mailing:send`, `supporters:export`, `money:refund` next to the read capabilities. Agents (MCP sessions) get the same capabilities and no more; "improve this text" never implies "mail everyone". A use case that publishes or sends requires the specific capability, and the registry conformance test asserts it.
6. **The teaser is explicit, never derived from block count.** `access.teaser` is one of: `lead` (metadata lead only; the default), `marker` (everything above a `paywall` boundary block the editor places in the tree), or `blocks: n` (explicit count, chosen by the editor with the preview open). The admin always shows the anonymous view before publishing a restricted item. `teaserBlocks` in ADR 016 rule 3 is replaced by this field.
7. **Access rules apply to every representation**: HTML, the JSON read route, feeds, search results, Markdown and `llms.txt`, sitemaps (restricted items are listed, their body never), og-images (never rendered from restricted blocks), and protected media (originals of restricted items are served through a signed URL, never from a public bucket path).
8. **Caching knows about access.** Public items: `Cache-Control: public, max-age, stale-while-revalidate` with `ETag`. Restricted items: `Cache-Control: private, no-store` and `Vary: Cookie`; the teaser view for anonymous readers is cached as public with a separate cache key. Reader-dependent responses never pass through a shared cache.
9. **Readiness is per locale.** An item's `status` is per locale (`locales: { nl: published, en: draft }`); publishing a correction in one locale never publishes an unfinished translation. Fallback to the default locale is a tenant setting (`i18n.fallback: none | default_locale`), off by default for restricted content.

## Rejected alternatives

- **Scheduled publish takes "latest at that moment"**: the Substack behaviour; convenient and the source of the "which version went out" confusion the review describes.
- **Last-write-wins saves with a warning**: loses work silently in a two-person newsroom, exactly the case fase 5 adds roles for.
- **Teaser as block count by default**: simple, and wrong for a one-block article.
- **One `content:write` capability for everything**: fewer checks, and an agent with editing rights could mail the whole list.

## Consequences

- TODO #8(a): `content.item.update` gains `baseRevisionId` and typed `conflict`; `content.item.schedule` takes a revision id; `status` becomes per locale; `access.teaser` replaces `teaserBlocks`; a `paywall` boundary block exists (renders to nothing for readers with access).
- TODO #15: the scheduled-publish job payload carries `revisionId`.
- TODO #7: the capability set in rule 5 is the minimum vocabulary.
- TODO #19 and #9: rules 7 and 8 are acceptance criteria; the block conformance suite asserts rule 7 for every renderer.
- Fase 4 mailing: rule 4 is the acceptance criterion for `mailing.send`.
- ADR 016 rule 3 and ADR 012 rules 4, 5 and 7 are read with this ADR.
