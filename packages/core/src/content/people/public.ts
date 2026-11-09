// Public people and their article cards share one availability decision with bylines. Only
// explicitly selected fields leave this module; rejected: returning the editorial Person and
// relying on each renderer to remove internal email or to filter a later draft's authors.
import { z } from 'zod';
import { notFound, UseCaseError } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { effectiveImages, effectiveSummary } from '../header/effective.js';
import { MAX_TRANSLATION_WALK } from '../listing.js';
import { statusOf } from '../lifecycle.js';
import { Person, Slug } from '../model.js';
import type { ItemRecord } from '../ports.js';
import { personPageStatus } from './model.js';

export const PublicPerson = z.object({
  id: z.string().guid(),
  slug: Slug,
  name: z.string(),
  bio: z.string().nullable(),
  role: z.string().nullable(),
  organisation: z.string().nullable(),
  publicEmail: z.string().email().nullable(),
  phone: z.string().nullable(),
  imageId: z.string().guid().nullable(),
  links: Person.shape.links,
});
export type PublicPerson = z.infer<typeof PublicPerson>;
export const PublishedArticleCard = z.object({
  id: z.string().guid(),
  slug: Slug,
  locale: Locale,
  title: z.string(),
  lead: z.string().nullable(),
  featuredImageId: z.string().guid().nullable(),
  publishedAt: z.string().datetime({ offset: true }),
  access: z.literal('public'),
});
export type PublishedArticleCard = z.infer<typeof PublishedArticleCard>;

export function projectPerson(person: Person, locale: string): PublicPerson {
  return {
    id: person.id,
    slug: person.slug,
    name: person.name,
    bio: person.bio?.[locale] ?? null,
    role: person.role?.[locale] ?? null,
    organisation: person.organisation ?? null,
    publicEmail: person.publicEmail ?? null,
    phone: person.phone ?? null,
    imageId: person.imageId ?? null,
    links: person.links,
  };
}

/** A published article in any locale enables auto, even when its body is restricted. */
export async function personPageEnabled(
  ctx: TransactionContext,
  person: Pick<Person, 'id' | 'pagePolicy'>,
  site?: { personPages?: 'auto' | 'off' | undefined }
): Promise<boolean> {
  const general = site ?? (await ctx.siteSettings.general()).value;
  // Off and explicit policies need no content read. A bio or an unpublished draft never counts.
  let count = 0;
  if (general.personPages !== 'off' && person.pagePolicy === 'auto') {
    const page = await ctx.content.find(
      { live: true, type: 'article', ref: { type: 'author', id: person.id } },
      null,
      1
    );
    count = page.rows.length;
  }
  return (
    personPageStatus(
      general.personPages ? { personPages: general.personPages } : {},
      person,
      count
    ) === 'enabled'
  );
}

async function articleCards(ctx: TransactionContext, personId: string, locale: string) {
  const cards: PublishedArticleCard[] = [];
  const images = (await ctx.siteSettings.images()).value;
  let after: string | null = null;
  let scanned = 0;
  do {
    const page = await ctx.content.find(
      { live: true, type: 'article', ref: { type: 'author', id: personId } },
      after,
      MAX_PAGE_SIZE
    );
    scanned += page.rows.length;
    if (scanned > MAX_TRANSLATION_WALK)
      throw new UseCaseError('invalid_input', 'the public person article list is too broad');
    for (const { item } of page.rows) {
      const card = await articleCard(ctx, item, personId, locale, images);
      if (card) cards.push(card);
    }
    after = page.next;
  } while (after);
  return cards.sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id)
  );
}
async function articleCard(
  ctx: TransactionContext,
  item: ItemRecord,
  personId: string,
  locale: string,
  images: { defaultImageId: string | null }
): Promise<PublishedArticleCard | null> {
  const state = item.publication.find((s) => s.locale === locale && statusOf(s) === 'published');
  if (!state?.publishedRevisionId || !state.publishedAt) return null;
  const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
  const doc = revision?.document;
  // Another locale may publish a different author set. Never use latest-revision list fields.
  if (
    !doc ||
    doc.type !== 'article' ||
    doc.access.level !== 'public' ||
    !doc.authorIds.includes(personId)
  )
    return null;
  return {
    id: item.id,
    slug: item.slug,
    locale,
    title: doc.title[locale] ?? '',
    lead: effectiveSummary(doc, locale).text,
    featuredImageId: effectiveImages(doc, images).featured.mediaId,
    publishedAt: state.publishedAt.toISOString(),
    access: doc.access.level,
  };
}

export const getPublicPerson = defineUseCase({
  name: 'content.public_person.get',
  kind: 'query',
  requires: 'content:read',
  description: 'Read an available public person and safe published article cards in one locale.',
  input: z.object({
    slug: Slug,
    locale: Locale,
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(9),
  }),
  output: z.object({
    person: PublicPerson,
    locale: Locale,
    articles: z.array(PublishedArticleCard),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nullable(),
  }),
  resource: { uriTemplate: 'mycel://public-person/{slug}/{locale}' },
  examples: [{ input: { slug: 'sam', locale: 'en' } }],
  async handler(ctx, { slug, locale, offset, limit }) {
    const person = await ctx.authors.findBySlug(slug);
    if (!person || !(await personPageEnabled(ctx, person))) throw notFound('public person');
    const cards = await articleCards(ctx, person.id, locale);
    return {
      person: projectPerson(person, locale),
      locale,
      articles: cards.slice(offset, offset + limit),
      total: cards.length,
      nextOffset: cards.length > offset + limit ? offset + limit : null,
    };
  },
});

export const listPublicPeople = defineUseCase({
  name: 'content.public_person.list',
  kind: 'query',
  requires: 'content:read',
  description:
    'List only available public people in one locale, for public discovery and sitemaps.',
  input: z.object({
    locale: Locale,
    after: z.string().guid().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  }),
  output: z.object({ people: z.array(PublicPerson), next: z.string().guid().nullable() }),
  examples: [{ input: { locale: 'en' } }],
  async handler(ctx, { locale, after, limit }) {
    const site = (await ctx.siteSettings.general()).value;
    if (site.personPages === 'off') return { people: [], next: null };
    const people: PublicPerson[] = [];
    let cursor: string | null = after ?? null;
    // The cursor follows the unfiltered register, so a run of unavailable people cannot hide
    // later available ones or repeat the previous page. Each response examines one bounded batch.
    const page = await ctx.authors.list(cursor, limit);
    for (const person of page.rows)
      if (await personPageEnabled(ctx, person, site)) people.push(projectPerson(person, locale));
    cursor = page.next;
    return { people, next: cursor };
  },
});
