// The public projection of a page, for the probe's web route until #8c brings full locale routing
// and the cached read route (ADR 012 rule 7). It reads only an explicitly published revision,
// first choosing a locale that is actually published, and returns that one locale: the other
// translations in the same revision snapshot, published or not, never leave the core (ADR 018
// rule 9, ADR 020 rule 8). Restricted pages are not served here at all; #19 brings the teaser.
//
// Rejected: returning the whole revision and letting the front pick a locale (an unpublished
// English draft would be in the HTML's data and the MCP output), and falling back to the latest
// revision when nothing is published (a frontend must never promote a draft on its own).

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import { Locale, negotiateLocale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import { Block, projectBlock } from './blocks.js';
import { Slug } from './model.js';
import { statusOf } from './lifecycle.js';
import './ports.js';

export const PublishedPage = z.object({
  id: z.string().uuid(),
  slug: Slug,
  revisionId: z.string().uuid(),
  /** The one locale this projection carries. */
  locale: Locale,
  /** Every locale of the page that is published, for language links. */
  locales: z.array(Locale),
  title: z.string(),
  blocks: z.array(Block),
  publishedAt: z.string().datetime({ offset: true }),
});
export type PublishedPage = z.infer<typeof PublishedPage>;

export const getPage = defineUseCase({
  name: 'content.page.get',
  kind: 'query',
  description:
    'Get the published version of a public page in one published locale, chosen from locale or acceptLanguage.',
  requires: 'content:read',
  input: z.object({
    slug: Slug,
    locale: Locale.optional(),
    acceptLanguage: z.string().max(500).optional(),
  }),
  output: PublishedPage,
  resource: { uriTemplate: 'mycel://pages/{slug}' },
  examples: [{ input: { slug: 'signup' } }],
  async handler(ctx, { slug, locale, acceptLanguage }) {
    const missing = () => new UseCaseError('not_found', `no published page with slug "${slug}"`);
    const item = await ctx.content.findBySlug('page', slug);
    if (!item) throw missing();
    const live = item.publication.filter((s) => statusOf(s) === 'published');
    const published = live.map((s) => s.locale);
    if (!published.length || (locale && !published.includes(locale))) throw missing();
    const chosen =
      locale ??
      negotiateLocale(
        acceptLanguage,
        published,
        published.includes(item.defaultLocale) ? item.defaultLocale : published[0]!
      );
    const state = live.find((s) => s.locale === chosen)!;
    const revision = await ctx.content.revision(item.id, state.publishedRevisionId!);
    if (!revision) throw missing();
    const doc = revision.document;
    if (doc.access.level !== 'public') throw missing();
    return {
      id: item.id,
      slug: item.slug,
      revisionId: revision.id,
      locale: chosen,
      locales: published,
      title: doc.title[chosen] ?? '',
      blocks: doc.blocks.map((b) => projectBlock(b, chosen)),
      publishedAt: state.publishedAt!.toISOString(),
    };
  },
});
