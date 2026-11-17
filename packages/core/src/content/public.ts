// The public projection of a page or article (brief #8c § 7): the one query every public
// representation derives from, the HTML of a site, the JSON read route (ADR 012 rule 7) and
// later Markdown and feeds (#9). It reads only an explicitly published revision and returns one
// published locale of it: the other translations in the same revision snapshot, published or
// not, never leave the core (ADR 018 rule 9, ADR 020 rule 8). A restricted item is served whole
// to a reader with access and as its teaser to everyone else (access/projection.ts): the body is
// cut from the document before anything below reads it, and `gate` says that it was.
//
// The locale is chosen by the caller (the HTML route from its path, the read route from
// `?locale=`), never negotiated from Accept-Language, so a response depends on its URL only and
// a shared cache needs no `Vary`. Without one, the item's default locale if it is published,
// else the first published one; an asked locale that is not published is `not_found`.
//
// The projection itself is `projectDocument`, a pure function the admin preview (#11) shares, so
// a preview shows a draft exactly as this route would show it once published.
//
// Rejected: returning the whole revision and letting the front pick a locale (an unpublished
// English draft would be in the HTML's data and the MCP output), falling back to the latest
// revision when nothing is published (a frontend must never promote a draft on its own), and
// keeping `content.page.get` as an alias (two names for one contract drift apart).

import { z } from 'zod';
import { notFound } from '../errors.js';
import { ARTICLE_HEADERS } from './model.js';
import { Locale } from '../i18n/locale.js';
import { defineUseCase } from '../registry.js';
import { AccessGate, accessProjection } from './access/projection.js';
import { Block, blockLocalized, projectBlock } from './blocks.js';
import { ContentType, LocalDateTime, Slug, type ContentDocument } from './model.js';
import { EffectiveView, effectiveOf } from './header/effective.js';
import { statusOf } from './lifecycle.js';
import { personPageEnabled } from './people/public.js';
import './ports.js';
import '../theme/ports.js';

export const PublishedEvent = z.object({
  startsAt: LocalDateTime,
  endsAt: LocalDateTime.nullable(),
  location: z.string().nullable(),
  onlineUrl: z.string().url().nullable(),
  timeZone: z.string(),
});
export type PublishedEvent = z.infer<typeof PublishedEvent>;

/** The event of a document in one locale; null unless it is an event page with a start. */
export function projectEvent(
  doc: ContentDocument,
  locale: string,
  timeZone: string
): PublishedEvent | null {
  if (doc.type !== 'page' || doc.profile !== 'event' || !doc.event?.startsAt) return null;
  const { startsAt, endsAt, location, onlineUrl } = doc.event;
  return {
    startsAt,
    endsAt: endsAt ?? null,
    location: location?.[locale] ?? null,
    onlineUrl: onlineUrl ?? null,
    timeZone,
  };
}

export const PublishedItem = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  revisionId: z.string().guid(),
  /** The one locale this projection carries. */
  locale: Locale,
  /** Every locale of the item that is published, for language links. */
  locales: z.array(Locale),
  title: z.string(),
  blocks: z.array(Block),
  publishedAt: z.string().datetime({ offset: true }),
  /** When the published revision was saved; a later draft does not move it. */
  updatedAt: z.string().datetime({ offset: true }),
  /** The image on the item's own page; null without one. */
  heroImageId: z.string().guid().nullable(),
  /** The hero's alt in this locale (#99); null: the hero is decorative. */
  heroAlt: z.string().nullable(),
  /** The item's own image, for cards that link to it; null without one. */
  featuredImageId: z.string().guid().nullable(),
  /**
   * Search and sharing in this locale: the explicit title and description (null: none set) and
   * the share image along the chain (`effective.images.share`).
   */
  seo: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    imageId: z.string().guid().nullable(),
    /** The alt of an own share image in this locale; null without one (or when it is inherited). */
    imageAlt: z.string().nullable(),
    /** The page is served but asks not to be indexed; lists and the sitemap leave it out. */
    noindex: z.boolean(),
    /** An explicit canonical URL; null: the item's own address in this locale. */
    canonical: z.string().url().nullable(),
  }),
  /** The access level of the served revision. */
  access: z.enum(['public', 'members', 'tier']),
  /**
   * Null: this is the whole item. Otherwise the body behind the teaser boundary, the corrections
   * and an event's details were left out for this caller, and `prompt` says what would open them.
   */
  gate: AccessGate.nullable(),
  /** The introduction in this locale, on pages and articles. */
  lead: z.string().nullable(),
  /** Images and short texts after inheritance (#86), so no reader derives them on its own. */
  effective: EffectiveView,
  corrections: z.array(z.object({ date: z.string().date(), text: z.string() })).optional(),
  authors: z
    .array(
      z.object({ id: z.string().guid(), slug: Slug, name: z.string(), pageEnabled: z.boolean() })
    )
    .optional(),
  section: z.object({ slug: Slug, name: z.string() }).nullable().optional(),
  /** An article's chosen header (ADR 025 rule 3); a renderer without a hero image shows `standard`. */
  presentation: z.object({ header: z.enum(ARTICLE_HEADERS) }).optional(),
  /**
   * An event page's when and where in this locale; absent on every other item. Times are
   * the wall clock of `timeZone`, the site's zone, which a representation needs for an offset.
   */
  event: PublishedEvent.optional(),
  /** `false` where the item hides the site's pre-footer zone; absent shows it. */
  prefooter: z.literal(false).optional(),
});
export type PublishedItem = z.infer<typeof PublishedItem>;

/**
 * The site-root path of an item in a locale (brief #8c § 8): `/<slug>` for a page, `/` for the
 * page `index`, `/articles/<slug>` for an article, with `/<locale>` in front for every locale but
 * the site's default (ADR 007 rule 3). Absolute URLs are this path through `siteUrl`.
 */
export function contentPath(
  item: { type: ContentType; slug: string },
  locale: string,
  defaultLocale: string
): string {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  if (item.type === 'page' && item.slug === 'index') return prefix || '/';
  return `${prefix}${item.type === 'article' ? '/articles' : ''}/${item.slug}`;
}

/**
 * One locale of a document: its title and the blocks reduced to that locale's values. A block
 * that lacks a required value in the locale is left out: a published locale passed
 * `readinessIssues`, so that never happens there, and a preview of an unfinished translation
 * shows what exists instead of an empty block.
 */
export function projectDocument(
  doc: Pick<ContentDocument, 'title' | 'blocks'>,
  locale: string
): { title: string; blocks: Block[] } {
  return {
    title: doc.title[locale] ?? '',
    blocks: doc.blocks
      .filter((b) => blockLocalized(b).every((f) => !f.required || f.value[locale] !== undefined))
      .map((b) => projectBlock(b, locale)),
  };
}

export const getPublished = defineUseCase({
  name: 'content.published.get',
  kind: 'query',
  description:
    'Get the published version of a page or article in one published locale (the default when none is asked). A restricted item comes whole only to a signed-in reader with access; every other caller gets its title, lead and teaser, with `gate` naming the prompt.',
  requires: 'content:read',
  input: z.object({ type: ContentType, slug: Slug, locale: Locale.optional() }),
  output: PublishedItem,
  resource: { uriTemplate: 'mycel://published/{type}/{slug}' },
  examples: [{ input: { type: 'page', slug: 'signup' } }],
  async handler(ctx, { type, slug, locale }) {
    const missing = () => notFound(`published ${type}`, `slug "${slug}"`);
    const item = await ctx.content.findBySlug(type, slug);
    // A zone is shown inside other pages, never at an address of its own.
    if (!item || item.profile === 'zone') throw missing();
    const live = item.publication.filter((s) => statusOf(s) === 'published');
    const published = live.map((s) => s.locale);
    if (!published.length || (locale && !published.includes(locale))) throw missing();
    const chosen =
      locale ?? (published.includes(item.defaultLocale) ? item.defaultLocale : published[0]!);
    const state = live.find((s) => s.locale === chosen)!;
    const revision = await ctx.content.revision(item.id, state.publishedRevisionId!);
    if (!revision) throw missing();
    // The one access decision (ADR 016 rule 3): everything below reads `doc`, never the revision.
    const { document: doc, gate } = await accessProjection(ctx, revision.document);
    const effective = effectiveOf(doc, chosen, (await ctx.siteSettings.images()).value);
    const base = {
      id: item.id,
      type: item.type,
      slug: item.slug,
      revisionId: revision.id,
      locale: chosen,
      locales: published,
      ...projectDocument(doc, chosen),
      publishedAt: state.publishedAt!.toISOString(),
      updatedAt: revision.createdAt,
      heroImageId: doc.heroImageId ?? null,
      heroAlt: doc.heroAlt?.[chosen] ?? null,
      featuredImageId: doc.featuredImageId ?? null,
      seo: {
        title: doc.seo.title?.[chosen] ?? null,
        description: doc.seo.description?.[chosen] ?? null,
        imageId: effective.images.share.mediaId,
        imageAlt: doc.seo.imageId ? (doc.seo.imageAlt?.[chosen] ?? null) : null,
        noindex: doc.seo.noindex,
        canonical: doc.seo.canonical ?? null,
      },
      access: doc.access.level,
      gate,
      lead: doc.lead?.[chosen] ?? null,
      effective,
      ...(doc.prefooter === false ? { prefooter: false as const } : {}),
    };
    if (doc.type !== 'article') {
      const event = projectEvent(doc, chosen, (await ctx.siteSettings.general()).value.timeZone);
      return event ? { ...base, event } : base;
    }

    // Authors and section as the public sees them: name and slug, never an author's e-mail.
    // A reference that no longer resolves is left out rather than failing the page.
    const authors = [];
    for (const id of doc.authorIds) {
      const author = await ctx.authors.get(id);
      if (author)
        authors.push({
          id: author.id,
          slug: author.slug,
          name: author.name,
          pageEnabled: await personPageEnabled(ctx, author),
        });
    }
    const section = doc.sectionId ? await ctx.sections.get(doc.sectionId) : null;
    return {
      ...base,
      presentation: { header: doc.presentation?.header ?? 'standard' },
      corrections: doc.corrections.flatMap((c) => {
        const text = c.text[chosen];
        return text ? [{ date: c.date, text }] : [];
      }),
      authors,
      section: section
        ? {
            slug: section.slug,
            // A section's title is not part of the item's readiness, so it may lack this locale.
            name:
              section.title[chosen] ??
              section.title[item.defaultLocale] ??
              Object.values(section.title)[0] ??
              section.slug,
          }
        : null,
    };
  },
});
