// Content item use cases (ADR 012, 018, 020): revisioned saves with optimistic concurrency and a
// publication state per locale. Business rules live here (ADR 001 rule 5); the database's
// unique indexes, composite foreign keys and RLS are the second line of defence.
//
// Every write takes the item lock first, so two saves on one base, a publish racing a save, and a
// scheduled job racing a reschedule all serialise in lock order. Writing never moves a
// publication pointer; publishing needs `content:publish` (ADR 018 rule 5). Every query here is
// editorial: `authenticatedOnly` keeps anonymous principals out whatever capability they carry,
// because drafts must never reach a public visitor (the public projection is `public.ts`).

import { z } from 'zod';
import { requireActive, requireEntitled } from '../entitlements/guards.js';
import { type Issue, notFound, UseCaseError } from '../errors.js';
import { zodIssues } from '../invoke.js';
import { Locale } from '../i18n/locale.js';
import type { JobOutcome } from '../jobs/ports.js';
import { jobKey, type JobPayload } from '../jobs/types.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import {
  allBlocks,
  assignBlockIds,
  blockReferences,
  type Block,
  type BlockInput,
} from './blocks.js';
import { EXAMPLE_IDS } from './block-types.js';
import { diffDocuments } from './diff.js';
import { EffectiveView, effectiveOf } from './effective.js';
import {
  draftLocale,
  publish,
  schedule,
  scheduledRun,
  statusOf,
  unpublish,
  unschedule,
  type LocaleState,
} from './lifecycle.js';
import {
  ContentDocument,
  ContentDocumentInput,
  ContentItem,
  ContentType,
  Revision,
  documentMedia,
  RevisionSummary,
  Slug,
  isReservedPageSlug,
  slugFromTitle,
  readinessIssues,
} from './model.js';
import type { ItemRecord } from './ports.js';
import { preserveTranslationReview } from './translation-review.js';
import './ports.js';
import '../theme/ports.js';
import { iso } from '../util/date.js';
import { exampleId } from '../util/ids.js';

export const DEFAULT_PAGE_SIZE = 20;
/** How long a scheduled publication of a suspended site waits before it looks again. */
export const SUSPENDED_RETRY_MS = 24 * 60 * 60 * 1000;
const Limit = z.number().int().min(1).max(100).optional();
const ItemId = z.string().guid();

export function toContentItem(r: ItemRecord): ContentItem {
  return {
    id: r.id,
    type: r.type,
    slug: r.slug,
    title: r.title,
    defaultLocale: r.defaultLocale,
    locales: r.locales,
    latestRevisionId: r.latestRevisionId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    publication: r.publication.map((s) => ({
      locale: s.locale,
      status: statusOf(s),
      publishedRevisionId: s.publishedRevisionId,
      publishedAt: iso(s.publishedAt),
      firstPublishedAt: iso(s.firstPublishedAt),
      scheduledRevisionId: s.scheduledRevisionId,
      scheduledFor: iso(s.scheduledFor),
      scheduleId: s.scheduleId,
      hasUnpublishedChanges:
        s.publishedRevisionId !== null && s.publishedRevisionId !== r.latestRevisionId,
    })),
  };
}

export async function lockItem(ctx: TransactionContext, itemId: string): Promise<ItemRecord> {
  const item = await ctx.content.lock(itemId);
  if (!item) throw notFound('content item');
  return item;
}

/**
 * Every block type in the tree must be switched on for the site (ADR 015, `blocks.<type>`): one
 * check for documents and patterns alike, so #8b2 only adds types. A block the site already has
 * cannot be saved again once its type is switched off; reading and publishing what exists stay.
 */
export function requireBlockTypes(
  ctx: TransactionContext,
  blocks: readonly { type: string }[]
): void {
  for (const type of new Set(allBlocks(blocks).map((b) => b.type)))
    requireEntitled(ctx.principal, `blocks.${type}`);
}

/** The document as stored: ids for new blocks, the full schema (defaults, invariants) re-checked. */
export function finalize(
  ctx: TransactionContext,
  input: ContentDocumentInput,
  blocks: readonly BlockInput[]
): ContentDocument {
  const parsed = ContentDocument.safeParse({
    ...input,
    machineTranslation: input.machineTranslation,
    blocks: assignBlockIds(blocks, () => ctx.ids.next()),
  });
  if (!parsed.success)
    throw new UseCaseError('invalid_input', 'document is not valid', zodIssues(parsed.error));
  requireBlockTypes(ctx, parsed.data.blocks);
  return parsed.data;
}

/** A stale base is a typed conflict before anything is read or written (ADR 018 rule 2). */
export function assertBase(item: ItemRecord, baseRevisionId: string): void {
  if (item.latestRevisionId !== baseRevisionId)
    throw new UseCaseError('conflict', 'the item has a newer revision than baseRevisionId', [
      {
        path: 'baseRevisionId',
        message: 'content.revision.conflict',
        params: { latestRevisionId: item.latestRevisionId },
      },
    ]);
}

/**
 * Records the media usages of a block tree under `ref` (`item:<id>:rev:<id>`, `pattern:<id>`), plus
 * a revision's own images (`document`, slots `doc:featured` and `doc:seo`), in
 * the caller's transaction and under the media lock its reference check took. The repository
 * skips an unknown or deleted id silently, so the count is compared with what was asked: a
 * shortfall throws and the whole save rolls back instead of leaving an image unprotected
 * (docs/reference/media.md § Usages).
 */
export async function recordMediaUsages(
  ctx: TransactionContext,
  ref: string,
  blocks: readonly Block[],
  document: readonly { slot: string; mediaId: string }[]
): Promise<void> {
  const pairs = new Map<string, { mediaId: string; blockId: string }>();
  for (const b of allBlocks(blocks))
    for (const mediaId of blockReferences([b]).media)
      pairs.set(`${mediaId} ${b.id}`, { mediaId, blockId: b.id });
  // The document's own images under their slot (`doc:featured`, `doc:seo`), which no block id
  // can take, so a featured image that is also a block's image counts twice, as it should.
  for (const { slot, mediaId } of document)
    pairs.set(`${mediaId} ${slot}`, { mediaId, blockId: slot });
  const usages = [...pairs.values()];
  const recorded = await ctx.media.replaceUsages(ref, usages);
  if (recorded !== usages.length)
    throw new UseCaseError('invalid_input', 'a media reference could not be recorded', [
      { path: 'blocks', message: 'content.reference.media-unrecorded' },
    ]);
}

/**
 * A revision's usages: its blocks and its document slots together, so no revision path can record
 * the one and silently skip the other (the slots were once added by hand on two paths).
 */
const recordRevisionUsages = (ctx: TransactionContext, revision: Revision) =>
  recordMediaUsages(
    ctx,
    `item:${revision.itemId}:rev:${revision.id}`,
    revision.document.blocks,
    documentMedia(revision.document)
  );

/** The one shape of a new revision, for a new item and for every write after it. */
const newRevision = (
  ctx: TransactionContext,
  itemId: string,
  document: ContentDocument,
  now: Date,
  provenance?: Revision['provenance']
): Revision => ({
  id: ctx.ids.next(),
  itemId,
  createdAt: now.toISOString(),
  actor: ctx.principal.actor,
  ...(provenance ? { provenance } : {}),
  document,
});

/**
 * One new revision on a locked item whose base was checked: insert it, move the latest pointer,
 * keep the publication rows of the locales that stay. Writing never moves a publication pointer.
 * `content.item.update` and every block operation end here.
 */
export async function writeRevision(
  ctx: TransactionContext,
  item: ItemRecord,
  doc: ContentDocument,
  provenance?: Revision['provenance'],
  clearTranslationLocale?: string
): Promise<{ item: ContentItem; revision: Revision }> {
  const previous = await ctx.content.revision(item.id, item.latestRevisionId);
  if (!previous) throw notFound('revision');
  doc = ContentDocument.parse(
    preserveTranslationReview(previous.document, doc, clearTranslationLocale)
  );
  await assertReferences(ctx, doc);
  const now = ctx.clock.now();
  const revision = newRevision(ctx, item.id, doc, now, provenance);
  const next: ItemRecord = {
    ...item,
    title: doc.title,
    defaultLocale: doc.defaultLocale,
    locales: doc.locales,
    latestRevisionId: revision.id,
    updatedAt: now,
    publication: doc.locales.map(
      (l) => item.publication.find((s) => s.locale === l) ?? draftLocale(l)
    ),
  };
  await ctx.content.insertRevision(revision);
  await recordRevisionUsages(ctx, revision);
  await ctx.content.save(next);
  return { item: toContentItem(next), revision };
}

/**
 * The references of a block tree must point at this tenant's data (ADR 004 rule 6): forms,
 * linked items, and media that exists, is not deleted and is an image (every media slot is an
 * image slot so far; a PDF is refused). Lookups run under the tenant's RLS context, so another
 * tenant's id is simply not found: the issue says which path, never whether the id exists
 * elsewhere. Restricted media may be referenced; that grants no reader access or address.
 *
 * With media in the tree this takes the media lock first, the lock `media.delete` takes, so a
 * save and a delete of the same image serialise: whichever commits second sees the other.
 * Callers that hold the item lock take it before this one, never the other way round.
 */
export async function blockReferenceIssues(
  ctx: TransactionContext,
  blocks: readonly BlockInput[],
  path = 'blocks'
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const refs = blockReferences(blocks);
  if (refs.media.length) await ctx.media.lock();
  for (const id of refs.forms)
    if (!(await ctx.forms.findById(id)))
      issues.push({ path, message: 'content.reference.form-unknown', params: { id } });
  for (const id of refs.items)
    if (!(await ctx.content.get(id)))
      issues.push({ path, message: 'content.reference.item-unknown', params: { id } });
  for (const id of refs.media) {
    const issue = await imageIssue(ctx, id, path);
    if (issue) issues.push(issue);
  }
  return issues;
}

/**
 * An image reference must exist, not be deleted and be an image: one rule for blocks, slots and
 * the site's default image (`site.image.update`).
 */
export async function imageIssue(
  ctx: TransactionContext,
  mediaId: string,
  path: string
): Promise<Issue | null> {
  const media = await ctx.media.get(mediaId);
  if (!media || media.deletedAt)
    return { path, message: 'content.reference.media-unknown', params: { id: mediaId } };
  if (media.kind !== 'image')
    return { path, message: 'content.reference.media-not-image', params: { id: mediaId } };
  return null;
}

/**
 * Block references, the document's own images (featured and share image, the same rule as an
 * image block), plus an article's authors and section: what every save and publish checks.
 */
export async function referenceIssues(
  ctx: TransactionContext,
  doc: ContentDocument
): Promise<Issue[]> {
  const images = documentMedia(doc);
  // The same media lock as the blocks' check; taking it twice in one run is a no-op.
  if (images.length) await ctx.media.lock();
  const issues = await blockReferenceIssues(ctx, doc.blocks);
  for (const { path, mediaId } of images) {
    const issue = await imageIssue(ctx, mediaId, path);
    if (issue) issues.push(issue);
  }
  if (doc.type === 'article') {
    for (const id of doc.authorIds)
      if (!(await ctx.authors.get(id)))
        issues.push({
          path: 'authorIds',
          message: 'content.reference.author-unknown',
          params: { id },
        });
    if (doc.sectionId && !(await ctx.sections.get(doc.sectionId)))
      issues.push({ path: 'sectionId', message: 'content.reference.section-unknown' });
  }
  return issues;
}

export async function assertReferences(
  ctx: TransactionContext,
  doc: ContentDocument
): Promise<void> {
  const issues = await referenceIssues(ctx, doc);
  if (issues.length)
    throw new UseCaseError('invalid_input', 'document references unknown data', issues);
}

/** Readiness of one locale plus fresh reference checks: what publish, schedule and the job run. */
export async function assertPublishable(
  ctx: TransactionContext,
  doc: ContentDocument,
  locale: string
): Promise<void> {
  const issues = [...readinessIssues(doc, locale), ...(await referenceIssues(ctx, doc))];
  if (issues.length)
    throw new UseCaseError('invalid_input', `locale "${locale}" cannot be published`, issues);
}

export const ItemWithRevision = z.object({ item: ContentItem, revision: Revision });

/**
 * An item read for editing: the revision plus its chain per locale of the document (#86), so an
 * agent sees what a card or a share preview will show without deriving it.
 */
export const ItemWithEffective = ItemWithRevision.extend({
  effective: z.record(Locale, EffectiveView),
});

const pageExample = {
  slug: 'about',
  document: {
    type: 'page' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Over ons', en: 'About us' },
    blocks: [
      { type: 'heading' as const, version: 1 as const, props: { text: { nl: 'Wie we zijn' } } },
      {
        type: 'rich-text' as const,
        version: 1 as const,
        props: {
          content: {
            nl: {
              type: 'doc' as const,
              content: [
                {
                  type: 'paragraph' as const,
                  content: [{ type: 'text' as const, text: 'Hallo.' }],
                },
              ],
            },
          },
        },
      },
    ],
  },
};

/**
 * The slug of a new item that gave none: its title in the default locale as a slug, with `-2`,
 * `-3` and so on when that is taken or reserved. A title with nothing usable falls back to the
 * type name.
 */
async function freeSlug(ctx: TransactionContext, document: ContentDocumentInput): Promise<string> {
  const title = document.title[document.defaultLocale] ?? Object.values(document.title)[0] ?? '';
  const stem = slugFromTitle(title) || document.type;
  for (let n = 1; n <= 100; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = `${stem.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (document.type === 'page' && isReservedPageSlug(slug)) continue;
    if (!(await ctx.content.findBySlug(document.type, slug))) return slug;
  }
  throw new UseCaseError('conflict', `no free slug for "${stem}"`);
}

export const createItem = defineUseCase({
  name: 'content.item.create',
  kind: 'command',
  description:
    'Create a page or article as a draft with its first revision; without a slug one is derived from the title in the default locale and made unique; blocks without an id get one, and patternId copies a pattern into the new document.',
  requires: 'content:write',
  authenticatedOnly: true,
  consumes: null,
  input: z.object({
    slug: Slug.optional(),
    document: ContentDocumentInput,
    patternId: z.string().guid().optional(),
  }),
  output: ItemWithRevision,
  examples: [
    { input: pageExample, note: 'Draft in two locales; the English body is not written yet.' },
  ],
  async handler(ctx, { slug: given, document, patternId }) {
    const slug = given ?? (await freeSlug(ctx, document));
    if (document.type === 'page' && isReservedPageSlug(slug))
      throw new UseCaseError('invalid_input', `"${slug}" is reserved`, [
        { path: 'slug', message: 'content.slug.reserved' },
      ]);
    if (await ctx.content.findBySlug(document.type, slug))
      throw new UseCaseError('conflict', `a ${document.type} with slug "${slug}" already exists`);
    let blocks: readonly BlockInput[] = document.blocks;
    if (patternId) {
      const pattern = await ctx.patterns.get(patternId);
      if (!pattern) throw notFound('pattern');
      if (blocks.length)
        throw new UseCaseError('invalid_input', 'give blocks or a pattern, not both', [
          { path: 'document.blocks', message: 'content.pattern.blocks-given' },
        ]);
      // A copy, not a link: the new document gets its own block ids.
      blocks = pattern.blocks.map(({ id: _id, ...b }) => b as BlockInput);
    }
    const doc = finalize(ctx, document, blocks);
    await assertReferences(ctx, doc);
    const now = ctx.clock.now();
    const itemId = ctx.ids.next();
    const revision = newRevision(ctx, itemId, doc, now);
    const item: ItemRecord = {
      id: itemId,
      type: doc.type,
      slug,
      title: doc.title,
      defaultLocale: doc.defaultLocale,
      locales: doc.locales,
      latestRevisionId: revision.id,
      createdAt: now,
      updatedAt: now,
      publication: doc.locales.map(draftLocale),
    };
    await ctx.content.insert(item, revision);
    await recordRevisionUsages(ctx, revision);
    return { item: toContentItem(item), revision };
  },
});

export const updateItem = defineUseCase({
  name: 'content.item.update',
  kind: 'command',
  description:
    'Save a new revision of an item; fails with conflict unless baseRevisionId is the latest revision, and never changes what is published.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({
    itemId: ItemId,
    baseRevisionId: z.string().guid(),
    document: ContentDocumentInput,
  }),
  output: ItemWithRevision,
  examples: [
    {
      input: {
        itemId: exampleId(0x1),
        baseRevisionId: exampleId(0x2),
        document: pageExample.document,
      },
    },
  ],
  async handler(ctx, { itemId, baseRevisionId, document }) {
    const item = await lockItem(ctx, itemId);
    assertBase(item, baseRevisionId);
    if (document.type !== item.type)
      throw new UseCaseError('invalid_input', 'the type of an item never changes', [
        { path: 'document.type', message: 'content.type.immutable' },
      ]);
    for (const s of item.publication)
      if (!document.locales.includes(s.locale) && (s.publishedRevisionId || s.scheduleId))
        throw new UseCaseError('invalid_input', `locale "${s.locale}" is published or planned`, [
          {
            path: 'document.locales',
            message: 'content.locale.still-live',
            params: { locale: s.locale },
          },
        ]);
    const previous = await ctx.content.revision(itemId, baseRevisionId);
    if (!previous) throw notFound('revision');
    const next = finalize(ctx, document, document.blocks);
    return writeRevision(ctx, item, next);
  },
});

export const getItem = defineUseCase({
  name: 'content.item.get',
  kind: 'query',
  description:
    'Get an item with its publication state and one revision: the latest, or revisionId if given.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, revisionId: z.string().guid().optional() }),
  output: ItemWithEffective,
  resource: { uriTemplate: 'mycel://content/{itemId}' },
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId, revisionId }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const revision = await ctx.content.revision(itemId, revisionId ?? item.latestRevisionId);
    if (!revision) throw notFound('revision');
    const doc = revision.document;
    const site = (await ctx.siteSettings.images()).value;
    const effective = Object.fromEntries(doc.locales.map((l) => [l, effectiveOf(doc, l, site)]));
    return { item: toContentItem(item), revision, effective };
  },
});

export const listItems = defineUseCase({
  name: 'content.item.list',
  kind: 'query',
  description:
    'List items newest first, optionally of one type or with one slug, a page at a time.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({
    type: ContentType.optional(),
    slug: Slug.optional(),
    after: z.string().guid().optional(),
    limit: Limit,
  }),
  output: z.object({ items: z.array(ContentItem), next: z.string().guid().nullable() }),
  examples: [{ input: { type: 'article' } }],
  async handler(ctx, { type, slug, after, limit }) {
    const page = await ctx.content.list({ type, slug }, after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { items: page.rows.map(toContentItem), next: page.next };
  },
});

export const listRevisions = defineUseCase({
  name: 'content.revision.list',
  kind: 'query',
  description: 'List the revisions of an item newest first, with who saved each and when.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, after: z.string().guid().optional(), limit: Limit }),
  output: z.object({ revisions: z.array(RevisionSummary), next: z.string().guid().nullable() }),
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId, after, limit }) {
    if (!(await ctx.content.get(itemId))) throw notFound('content item');
    const page = await ctx.content.revisions(itemId, after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { revisions: page.rows, next: page.next };
  },
});

export const diffRevisions = defineUseCase({
  name: 'content.revision.diff',
  kind: 'query',
  description:
    'Compare two revisions of one item as a list of changed paths with the value before and after.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({
    itemId: ItemId,
    fromRevisionId: z.string().guid(),
    toRevisionId: z.string().guid(),
  }),
  output: z.object({
    changes: z.array(
      z.object({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })
    ),
  }),
  examples: [
    {
      input: {
        itemId: exampleId(0x1),
        fromRevisionId: exampleId(0x2),
        toRevisionId: exampleId(0x3),
      },
    },
  ],
  async handler(ctx, { itemId, fromRevisionId, toRevisionId }) {
    const [from, to] = await Promise.all([
      ctx.content.revision(itemId, fromRevisionId),
      ctx.content.revision(itemId, toRevisionId),
    ]);
    if (!from || !to) throw notFound('revision');
    return { changes: diffDocuments(from.document, to.document) };
  },
});

/** Lock, find the locale, apply `change`, save: the shape of every publication command. */
async function changePublication(
  ctx: TransactionContext,
  itemId: string,
  locale: string,
  change: (state: LocaleState, item: ItemRecord) => Promise<LocaleState>
): Promise<ContentItem> {
  const item = await lockItem(ctx, itemId);
  const state = item.publication.find((s) => s.locale === locale);
  if (!state)
    throw new UseCaseError('invalid_input', `the item has no locale "${locale}"`, [
      { path: 'locale', message: 'content.publish.locale-not-in-item' },
    ]);
  const next = await change(state, item);
  if (next === state) return toContentItem(item);
  const saved: ItemRecord = {
    ...item,
    publication: item.publication.map((s) => (s.locale === locale ? next : s)),
  };
  await ctx.content.save(saved);
  return toContentItem(saved);
}

async function publishableRevision(
  ctx: TransactionContext,
  itemId: string,
  revisionId: string,
  locale: string
): Promise<Revision> {
  const revision = await ctx.content.revision(itemId, revisionId);
  if (!revision) throw notFound('revision');
  await assertPublishable(ctx, revision.document, locale);
  return revision;
}

const PublicationTarget = z.object({
  itemId: ItemId,
  revisionId: z.string().guid(),
  locale: Locale,
});
const exampleTarget = {
  itemId: exampleId(0x1),
  revisionId: exampleId(0x2),
  locale: 'nl',
};

export const publishItem = defineUseCase({
  name: 'content.item.publish',
  kind: 'command',
  description:
    'Put one revision live in one locale; other locales and newer drafts are untouched, and any planning for this locale is cancelled.',
  requires: 'content:publish',
  effect: 'publish',
  authenticatedOnly: true,
  input: PublicationTarget,
  output: ContentItem,
  examples: [{ input: exampleTarget }],
  handler: (ctx, { itemId, revisionId, locale }) =>
    changePublication(ctx, itemId, locale, async (state) => {
      await publishableRevision(ctx, itemId, revisionId, locale);
      return publish(state, revisionId, ctx.clock.now());
    }),
});

export const unpublishItem = defineUseCase({
  name: 'content.item.unpublish',
  kind: 'command',
  description:
    'Take one locale of an item offline and cancel its planning; other locales stay as they are.',
  requires: 'content:publish',
  effect: 'publish',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, locale: Locale }),
  output: ContentItem,
  examples: [{ input: { itemId: exampleTarget.itemId, locale: 'nl' } }],
  handler: (ctx, { itemId, locale }) =>
    changePublication(ctx, itemId, locale, async (state) =>
      state.publishedRevisionId || state.scheduleId ? unpublish(state) : state
    ),
});

export const scheduleItem = defineUseCase({
  name: 'content.item.schedule',
  kind: 'command',
  description:
    'Plan one revision to go live in one locale at a future time; exactly that revision is published, and scheduling again replaces the plan.',
  requires: 'content:publish',
  effect: 'publish',
  authenticatedOnly: true,
  input: PublicationTarget.extend({ at: z.string().datetime({ offset: true }) }),
  output: ContentItem,
  examples: [{ input: { ...exampleTarget, at: '2030-01-01T09:00:00+01:00' } }],
  handler: (ctx, { itemId, revisionId, locale, at }) =>
    changePublication(ctx, itemId, locale, async (state) => {
      const when = new Date(at);
      if (when.getTime() <= ctx.clock.now().getTime())
        throw new UseCaseError('invalid_input', 'the time is not in the future', [
          { path: 'at', message: 'content.schedule.not-in-future' },
        ]);
      await publishableRevision(ctx, itemId, revisionId, locale);
      const scheduleId = ctx.ids.next();
      // The key carries locale and scheduleId: an open job for an older plan never blocks this
      // one, and the handler recognises such a job as stale (brief #8a § 4).
      await ctx.jobs.enqueue({
        type: 'content.publish',
        key: jobKey('content.publish', `${itemId}:${locale}:${scheduleId}`),
        runAt: when,
        payload: { itemId, revisionId, locale, scheduleId },
      });
      return schedule(state, revisionId, when, scheduleId);
    }),
});

export const unscheduleItem = defineUseCase({
  name: 'content.item.unschedule',
  kind: 'command',
  description: 'Cancel the planned publication of one locale; what is live stays live.',
  requires: 'content:publish',
  effect: 'publish',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, locale: Locale }),
  output: ContentItem,
  examples: [{ input: { itemId: exampleTarget.itemId, locale: 'nl' } }],
  handler: (ctx, { itemId, locale }) =>
    changePublication(ctx, itemId, locale, async (state) =>
      state.scheduleId ? unschedule(state) : state
    ),
});

/**
 * The `content.publish` job (ADR 018 rule 1): publish exactly the pinned revision, under the item
 * lock. A job whose plan was cancelled, replaced or already carried out is a successful no-op; a
 * job that runs early asks to be run again at the pinned time. A revision that is no longer
 * publishable throws, so the worker's retry and exhaustion route takes over and what is live
 * stays live (#17 makes exhausted jobs visible).
 */
export async function publishScheduled(
  ctx: TransactionContext,
  job: JobPayload<'content.publish'>
): Promise<JobOutcome> {
  const item = await ctx.content.lock(job.itemId);
  if (!item) return {};
  const state = item.publication.find((s) => s.locale === job.locale);
  const run = scheduledRun(state, job, ctx.clock.now());
  if (run.kind === 'stale' || !state) return {};
  if (run.kind === 'early') return { next: run.at };
  // A suspended site publishes nothing (ADR 015 rule 7); the job comes back tomorrow with its
  // pin, instead of using up attempts or losing the planned revision.
  try {
    requireActive(ctx.principal);
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'suspended')
      return { next: new Date(ctx.clock.now().getTime() + SUSPENDED_RETRY_MS) };
    throw e;
  }
  await publishableRevision(ctx, job.itemId, run.revisionId, job.locale);
  await ctx.content.save({
    ...item,
    publication: item.publication.map((s) =>
      s.locale === job.locale ? publish(s, run.revisionId, ctx.clock.now()) : s
    ),
  });
  return {};
}

/**
 * A human publisher clears the machine-translation marker of one locale (ADR 024). It lives with
 * content, not assist: it writes a revision and needs `content:publish`, whatever produced the
 * text; the issue key stays the one the editor already shows.
 */
export const approveTranslation = defineUseCase({
  name: 'content.translation.approve',
  kind: 'command',
  description: 'Approve the machine-translated fields of one locale as a human publisher.',
  requires: 'content:publish',
  authenticatedOnly: true,
  actors: ['operator'],
  input: z
    .object({ itemId: ItemId, locale: z.string().min(2), baseRevisionId: z.string().guid() })
    .strict(),
  output: z.object({ revisionId: z.string().guid() }),
  examples: [
    { input: { itemId: EXAMPLE_IDS.item, locale: 'en', baseRevisionId: EXAMPLE_IDS.item } },
  ],
  async handler(ctx, input) {
    const item = await lockItem(ctx, input.itemId);
    assertBase(item, input.baseRevisionId);
    const revision = await ctx.content.revision(item.id, item.latestRevisionId);
    if (!revision) throw notFound('revision');
    if (!revision.document.locales.includes(input.locale))
      throw new UseCaseError('invalid_input', 'locale', [
        { path: '', message: 'assist.error.locale' },
      ]);
    const markers = { ...(revision.document.machineTranslation ?? {}) };
    delete markers[input.locale];
    const written = await writeRevision(
      ctx,
      item,
      ContentDocument.parse({ ...revision.document, machineTranslation: markers }),
      undefined,
      input.locale
    );
    return { revisionId: written.revision.id };
  },
});
