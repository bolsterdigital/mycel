// The content model (ADR 012, amended by ADR 018 and ADR 020): one item identity, immutable
// revisions holding the whole document, and a publication state per locale. A document is
// `{ type, title, locales, blocks, seo, access }` plus article fields; every localisable field is
// a `{ [locale]: value }` map on the same document (ADR 007).
//
// Drafts may miss translations; `readinessIssues` is the per-locale check that publishing and
// scheduling run, so a fallback never makes an unfinished translation look published. Rejected:
// one document per locale, and draft and live as two tables of documents (ADR 012 rule 4).

import { z } from 'zod';
import { Actor } from '../principal.js';
import { Locale, localized } from '../i18n/locale.js';
import {
  Block,
  BlockInput,
  allBlocks,
  blockLocalized,
  blockReferenceRows,
  blockTreeIssues,
  type BlockInput as BlockInputT,
  type ReferenceType,
} from './blocks.js';

export const ContentType = z.enum(['page', 'article']);
export type ContentType = z.infer<typeof ContentType>;

/** One lowercase ASCII path segment, the probe's grammar; not localised in v1. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'content.slug.invalid');

/**
 * Page slugs that would shadow a route of the public site or the platform (docs/reference/
 * content-model.md). Strings that parse as a Locale are reserved as well, so adding a locale to a
 * tenant later can never take over an existing page's URL. `index` is not reserved: it is the
 * page served at `/`.
 */
export const RESERVED_PAGE_SLUGS = [
  'admin',
  'api',
  'internal',
  'v1',
  'confirm',
  'reader',
  'articles',
  'authors',
  'sections',
  'tags',
  'assets',
  '_app',
  // `/media/<id>/<variant>` is the delivery route of every site (TODO #10).
  'media',
  'healthz',
  'thanks',
  'robots.txt',
  'favicon.ico',
] as const;

export function isReservedPageSlug(slug: string): boolean {
  return (
    (RESERVED_PAGE_SLUGS as readonly string[]).includes(slug) || Locale.safeParse(slug).success
  );
}

/** Tags are strings (ADR 012 rule 3); this is their identity: NFC, trimmed, lowercase, single spaces. */
export function canonicalTag(tag: string): string {
  return tag.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const TAG = /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u;
export const MAX_TAGS = 20;
export const Tags = z
  .array(z.string().max(200))
  .max(100)
  .transform((tags) => [...new Set(tags.map(canonicalTag))])
  .pipe(z.array(z.string().min(1).max(50).regex(TAG, 'content.tag.invalid')).max(MAX_TAGS));

/** Absolute http(s) URL without credentials. */
const CanonicalUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'content.seo.canonical.invalid');

/**
 * Search and sharing metadata, stored with the revision. Absent fields are derived (title, lead)
 * by #9; a present field is an explicit override. `imageId` names a media asset (#10), never a
 * vendor URL.
 */
export const Seo = z
  .object({
    title: localized(z.string().min(1).max(200)).optional(),
    description: localized(z.string().min(1).max(500)).optional(),
    noindex: z.boolean().default(false),
    canonical: CanonicalUrl.optional(),
    imageId: z.string().uuid().optional(),
  })
  .strict();

/** ADR 016 rule 3 with ADR 018 rule 6: who may read the body, and what everyone else sees. */
export const Teaser = z.union([
  z.literal('lead'),
  z.literal('marker'),
  z.object({ blocks: z.number().int().min(0).max(200) }).strict(),
]);
export const Access = z
  .object({
    level: z.enum(['public', 'members', 'tier']),
    tierIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    teaser: Teaser.default('lead'),
  })
  .strict();
export type Access = z.infer<typeof Access>;

const Correction = z
  .object({
    date: z.string().date(),
    text: localized(z.string().min(1).max(2000)),
  })
  .strict();

/**
 * ADR 012 rule 5. Only what an editor configures: `sentAt` and `campaignId` are written by the
 * mailing module when it sends (fase 4), never by a content save.
 */
const Delivery = z
  .object({
    web: z.boolean().default(true),
    email: z
      .object({
        listId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        subject: localized(z.string().min(1).max(200)),
      })
      .strict()
      .optional(),
  })
  .strict();

const LocaleList = z
  .array(Locale)
  .min(1)
  .max(10)
  .refine((l) => new Set(l).size === l.length, 'i18n.locales.duplicate');

function documentSchemas<B extends typeof Block | typeof BlockInput>(block: B) {
  const base = {
    title: localized(z.string().min(1).max(200)),
    defaultLocale: Locale,
    locales: LocaleList,
    blocks: z.array(block).max(1000),
    seo: Seo.default({}),
    access: Access.default({ level: 'public' }),
  };
  const page = z.object({ type: z.literal('page'), ...base }).strict();
  const article = z
    .object({
      type: z.literal('article'),
      ...base,
      lead: localized(z.string().min(1).max(1000)).optional(),
      authorIds: z
        .array(z.string().uuid())
        .max(20)
        .refine((a) => new Set(a).size === a.length, 'content.authors.duplicate')
        .default([]),
      sectionId: z.string().uuid().nullable().default(null),
      tags: Tags.default([]),
      corrections: z.array(Correction).max(100).default([]),
      delivery: Delivery.default({}),
    })
    .strict();
  return z.discriminatedUnion('type', [page, article]).superRefine((doc, ctx) => {
    for (const issue of documentIssues(doc as DocumentShape))
      ctx.addIssue({ code: 'custom', ...issue });
  });
}

/** A stored revision's document: every block has its id. */
export const ContentDocument = documentSchemas(Block);
export type ContentDocument = z.infer<typeof ContentDocument>;

/** A document as a caller sends it: new blocks may omit their id. */
export const ContentDocumentInput = documentSchemas(BlockInput);
export type ContentDocumentInput = z.infer<typeof ContentDocumentInput>;

type DocumentShape = ContentDocumentInput;

/** Every localised map of a document, with its path and whether a published locale needs it. */
export function localizedFields(
  doc: DocumentShape
): { path: (string | number)[]; value: Record<string, unknown>; required: boolean }[] {
  const fields: { path: (string | number)[]; value: Record<string, unknown>; required: boolean }[] =
    [{ path: ['title'], value: doc.title, required: true }];
  if (doc.seo.title) fields.push({ path: ['seo', 'title'], value: doc.seo.title, required: false });
  if (doc.seo.description)
    fields.push({ path: ['seo', 'description'], value: doc.seo.description, required: false });
  allBlocks(doc.blocks).forEach((b, i) => {
    for (const f of blockLocalized(b)) fields.push({ ...f, path: ['blocks', i, ...f.path] });
  });
  if (doc.type === 'article') {
    // A lead given in one locale is part of the visible article in every published locale.
    if (doc.lead) fields.push({ path: ['lead'], value: doc.lead, required: true });
    doc.corrections.forEach((c, i) =>
      fields.push({ path: ['corrections', i, 'text'], value: c.text, required: true })
    );
    if (doc.delivery.email)
      fields.push({
        path: ['delivery', 'email', 'subject'],
        value: doc.delivery.email.subject,
        required: true,
      });
  }
  return fields;
}

/** Shape-independent invariants, for every save (drafts included). */
function documentIssues(doc: DocumentShape): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (!doc.locales.includes(doc.defaultLocale))
    issues.push({ path: ['defaultLocale'], message: 'i18n.default-not-in-locales' });
  // A value for a locale the document does not have is a mistake, not a hidden translation.
  for (const field of localizedFields(doc))
    for (const key of Object.keys(field.value))
      if (!doc.locales.includes(key))
        issues.push({ path: [...field.path, key], message: 'i18n.locale-not-in-document' });
  for (const issue of blockTreeIssues(doc.blocks))
    issues.push({ path: ['blocks', ...issue.path], message: issue.message });
  issues.push(...accessIssues(doc));
  return issues;
}

function accessIssues(doc: DocumentShape): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const { level, tierIds, teaser } = doc.access;
  if (level === 'tier' && !tierIds)
    issues.push({ path: ['access', 'tierIds'], message: 'content.access.tier-ids-required' });
  if (level !== 'tier' && tierIds)
    issues.push({ path: ['access', 'tierIds'], message: 'content.access.tier-ids-unexpected' });
  // A paywall boundary only means something as the marker teaser, and then exactly once at the
  // top of the tree; nested boundaries would make "everything above" ambiguous.
  const topLevel = doc.blocks.filter((b) => b.type === 'paywall').length;
  const total = allBlocks(doc.blocks as readonly BlockInputT[]).filter(
    (b) => b.type === 'paywall'
  ).length;
  if (teaser === 'marker' && (topLevel !== 1 || total !== 1))
    issues.push({ path: ['access', 'teaser'], message: 'content.access.marker-needs-one-paywall' });
  if (teaser !== 'marker' && total > 0)
    issues.push({ path: ['blocks'], message: 'content.access.paywall-without-marker' });
  if (typeof teaser === 'object' && teaser.blocks > doc.blocks.length)
    issues.push({
      path: ['access', 'teaser', 'blocks'],
      message: 'content.access.teaser-too-long',
    });
  return issues;
}

/**
 * What stops `locale` of this document from being published (ADR 018 rule 9): the locale must be
 * one of the document's, every required visible field must have a value in it (no fallback), an
 * article needs an author, and a restricted article with the default teaser needs its lead. Tier
 * access fails closed until #19 can verify tier ids. References are checked separately, against
 * the tenant's data.
 */
export function readinessIssues(
  doc: ContentDocument,
  locale: string
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (!doc.locales.includes(locale))
    return [{ path: 'locale', message: 'content.publish.locale-not-in-document' }];
  for (const field of localizedFields(doc))
    if (field.required && field.value[locale] === undefined)
      issues.push({ path: field.path.join('.'), message: 'content.publish.missing-translation' });
  if (doc.type === 'article') {
    if (doc.authorIds.length === 0)
      issues.push({ path: 'authorIds', message: 'content.publish.author-required' });
    if (doc.access.level !== 'public' && doc.access.teaser === 'lead' && !doc.lead)
      issues.push({ path: 'lead', message: 'content.publish.teaser-lead-required' });
  }
  if (doc.access.level === 'tier')
    issues.push({ path: 'access.tierIds', message: 'content.publish.tier-unverifiable' });
  return issues;
}

/** One row of `content_block_refs`: `blockId` is null for a reference the document itself makes. */
export interface DocumentReference {
  blockId: string | null;
  type: ReferenceType;
  refId: string;
}

/**
 * Every structured reference of a stored document (ADR 020 rule 7): the blocks' forms, items and
 * media, plus an article's authors and section. The repositories derive `content_block_refs`
 * from this on every revision insert, and migration 0017's backfill is its SQL twin.
 */
export function documentReferences(doc: ContentDocument): DocumentReference[] {
  const refs: DocumentReference[] = blockReferenceRows(doc.blocks);
  if (doc.type === 'article') {
    for (const id of doc.authorIds) refs.push({ blockId: null, type: 'author', refId: id });
    if (doc.sectionId) refs.push({ blockId: null, type: 'section', refId: doc.sectionId });
  }
  return refs;
}

/** Per item and locale (ADR 018 rule 9). The status is derived from the pointers, never stored apart. */
export const LocaleStatus = z.enum(['draft', 'scheduled', 'published', 'unpublished']);
export type LocaleStatus = z.infer<typeof LocaleStatus>;

const Timestamp = z.string().datetime({ offset: true });

export const LocalePublication = z.object({
  locale: Locale,
  status: LocaleStatus,
  publishedRevisionId: z.string().uuid().nullable(),
  publishedAt: Timestamp.nullable(),
  firstPublishedAt: Timestamp.nullable(),
  scheduledRevisionId: z.string().uuid().nullable(),
  scheduledFor: Timestamp.nullable(),
  scheduleId: z.string().uuid().nullable(),
  /** Published, and the latest revision is not the published one (ADR 018 rule 3). */
  hasUnpublishedChanges: z.boolean(),
});
export type LocalePublication = z.infer<typeof LocalePublication>;

export const ContentItem = z.object({
  id: z.string().uuid(),
  type: ContentType,
  slug: Slug,
  title: localized(z.string()),
  defaultLocale: Locale,
  locales: z.array(Locale),
  latestRevisionId: z.string().uuid(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  publication: z.array(LocalePublication),
});
export type ContentItem = z.infer<typeof ContentItem>;

export const Revision = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  createdAt: Timestamp,
  actor: Actor,
  document: ContentDocument,
});
export type Revision = z.infer<typeof Revision>;

export const RevisionSummary = Revision.omit({ document: true });
export type RevisionSummary = z.infer<typeof RevisionSummary>;

/** Tenant entities next to content (ADR 012 rules 2 and 3). `email` is internal, never public. */
export const AuthorInput = z
  .object({
    name: z.string().min(1).max(200),
    bio: localized(z.string().min(1).max(5000)).optional(),
    imageId: z.string().uuid().optional(),
    links: z
      .array(z.object({ label: z.string().min(1).max(100), url: CanonicalUrl }).strict())
      .max(10)
      .default([]),
    email: z.string().email().max(320).optional(),
  })
  .strict();
export const Author = AuthorInput.extend({
  id: z.string().uuid(),
  slug: Slug,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Author = z.infer<typeof Author>;

export const SectionInput = z
  .object({
    title: localized(z.string().min(1).max(200)),
    description: localized(z.string().min(1).max(2000)).optional(),
    order: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export const Section = SectionInput.extend({
  id: z.string().uuid(),
  slug: Slug,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Section = z.infer<typeof Section>;

/** A stored block tree that seeds a new document (ADR 012 rule 8); applying it copies the blocks. */
export const PatternInput = z
  .object({
    name: localized(z.string().min(1).max(200)),
    description: localized(z.string().min(1).max(2000)).optional(),
    intendedType: ContentType,
    blocks: z
      .array(BlockInput)
      .max(1000)
      .superRefine((blocks, ctx) => {
        for (const issue of blockTreeIssues(blocks))
          ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }),
  })
  .strict();
export const Pattern = PatternInput.extend({
  id: z.string().uuid(),
  blocks: z.array(Block),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Pattern = z.infer<typeof Pattern>;
