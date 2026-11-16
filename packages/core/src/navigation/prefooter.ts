// The pre-footer zone (brief prefooter): a page with the profile `zone`, placed by the
// navigation document (ADR 036 rule 4 as amended 2026-11-16) and shown between the content and
// the footer of every page and article that does not switch it off (`prefooter: false`).
//
// `site.prefooter.get` reads it the way the site shows it: the zone the published navigation of
// the locale places, in the revision that publishes it there, reduced to that locale. It goes
// through `publishedNavigation`, so the zone a page renders and the zone the ETag names are the
// same answer. `placingNavigation` is the delete check of rule 9 for the zone: the latest draft
// and every published revision count, older revisions do not.
//
// Rejected: a zone read by id from the web front (a second place deciding what is live) and a
// reference row in `site_navigation_refs` (its key is a menu; a placement is not one, and the
// check below reads at most one revision per published locale).

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { Block } from '../content/blocks.js';
import { projectDocument } from '../content/public.js';
import { publishedNavigation } from './service.js';
import './ports.js';
import '../content/ports.js';

export const PublishedZone = z.object({
  itemId: z.string().guid(),
  revisionId: z.string().guid(),
  /** The zone's title in the locale: the accessible name of its `aside`, not a heading. */
  title: z.string(),
  blocks: z.array(Block),
});
export type PublishedZone = z.infer<typeof PublishedZone>;

export const getPrefooter = defineUseCase({
  name: 'site.prefooter.get',
  kind: 'query',
  description:
    'The pre-footer zone the published navigation places in one locale, as visitors see it: its title and its blocks in that locale. `zone` is null when nothing is placed or the zone is not published publicly there.',
  requires: 'content:read',
  input: z.object({ locale: Locale }).strict(),
  output: z.object({ zone: PublishedZone.nullable() }),
  examples: [{ input: { locale: 'nl' } }],
  async handler(ctx, { locale }) {
    const { prefooter } = await publishedNavigation(ctx, locale);
    const revision = prefooter
      ? await ctx.content.revision(prefooter.itemId, prefooter.revisionId)
      : null;
    if (!prefooter || !revision) return { zone: null };
    return { zone: { ...prefooter, ...projectDocument(revision.document, locale) } };
  },
});

/** Whether the latest navigation draft or a published revision places this item as pre-footer. */
export async function placingNavigation(ctx: TransactionContext, itemId: string): Promise<boolean> {
  const head = await ctx.navigation.head();
  if (!head) return false;
  const ids = new Set([head.latestRevisionId, ...head.publication.map((p) => p.revisionId)]);
  for (const id of ids) {
    const revision = await ctx.navigation.revision(id);
    if (revision?.document.placements.prefooter?.itemId === itemId) return true;
  }
  return false;
}
