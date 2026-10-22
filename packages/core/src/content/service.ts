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
import { requireActive, requireEntitled } from '../entitlements/check.js';
import { UseCaseError, type Issue } from '../errors.js';
import { zodIssues } from '../invoke.js';
import { Locale } from '../i18n/locale.js';
import type { JobOutcome } from '../jobs/ports.js';
import { jobKey, type JobPayload } from '../jobs/types.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { allBlocks, assignBlockIds, blockReferences, type BlockInput } from './blocks.js';
import { diffDocuments } from './diff.js';
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
  RevisionSummary,
  Slug,
  isReservedPageSlug,
  readinessIssues,
} from './model.js';
import type { ItemRecord } from './ports.js';
import './ports.js';

export const DEFAULT_PAGE_SIZE = 20;
/** How long a scheduled publication of a suspended site waits before it looks again. */
export const SUSPENDED_RETRY_MS = 24 * 60 * 60 * 1000;
const Limit = z.number().int().min(1).max(100).optional();
const ItemId = z.string().uuid();

export function toContentItem(r: ItemRecord): ContentItem {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
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

const notFound = (what: string) => new UseCaseError('not_found', `no ${what} with that id`);

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
      { path: 'baseRevisionId', message: `content.revision.conflict:${item.latestRevisionId}` },
    ]);
}

/** Media usages of one revision, in the save's transaction (docs/reference/media.md § Usages). */
async function recordMediaUsages(ctx: TransactionContext, revision: Revision): Promise<void> {
  const usages = allBlocks(revision.document.blocks).flatMap((b) =>
    blockReferences([b]).media.map((mediaId) => ({ mediaId, blockId: b.id }))
  );
  await ctx.media.replaceUsages(`item:${revision.itemId}:rev:${revision.id}`, usages);
}

/**
 * One new revision on a locked item whose base was checked: insert it, move the latest pointer,
 * keep the publication rows of the locales that stay. Writing never moves a publication pointer.
 * `content.item.update` and every block operation end here.
 */
export async function writeRevision(
  ctx: TransactionContext,
  item: ItemRecord,
  doc: ContentDocument
): Promise<{ item: ContentItem; revision: Revision }> {
  await assertReferences(ctx, doc);
  const now = ctx.clock.now();
  const revision: Revision = {
    id: ctx.ids.next(),
    itemId: item.id,
    createdAt: now.toISOString(),
    actor: ctx.principal.actor,
    document: doc,
  };
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
  await recordMediaUsages(ctx, revision);
  await ctx.content.save(next);
  return { item: toContentItem(next), revision };
}

/**
 * Every reference must point at this tenant's data (ADR 004 rule 6, ADR 012). Lookups run under
 * the tenant's RLS context, so another tenant's id is simply not found: the issue says which
 * path, never whether the id exists elsewhere.
 */
export async function referenceIssues(
  ctx: TransactionContext,
  doc: ContentDocument
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const refs = blockReferences(doc.blocks);
  for (const id of refs.forms)
    if (!(await ctx.forms.findById(id)))
      issues.push({ path: 'blocks', message: `content.reference.form-unknown:${id}` });
  for (const id of refs.items)
    if (!(await ctx.content.get(id)))
      issues.push({ path: 'blocks', message: `content.reference.item-unknown:${id}` });
  if (doc.type === 'article') {
    for (const id of doc.authorIds)
      if (!(await ctx.authors.get(id)))
        issues.push({ path: 'authorIds', message: `content.reference.author-unknown:${id}` });
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

export const createItem = defineUseCase({
  name: 'content.item.create',
  kind: 'command',
  description:
    'Create a page or article as a draft with its first revision; blocks without an id get one, and patternId copies a pattern into the new document.',
  requires: 'content:write',
  authenticatedOnly: true,
  consumes: null,
  input: z.object({
    slug: Slug,
    document: ContentDocumentInput,
    patternId: z.string().uuid().optional(),
  }),
  output: ItemWithRevision,
  examples: [
    { input: pageExample, note: 'Draft in two locales; the English body is not written yet.' },
  ],
  async handler(ctx, { slug, document, patternId }) {
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
    const revision: Revision = {
      id: ctx.ids.next(),
      itemId,
      createdAt: now.toISOString(),
      actor: ctx.principal.actor,
      document: doc,
    };
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
    await recordMediaUsages(ctx, revision);
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
    baseRevisionId: z.string().uuid(),
    document: ContentDocumentInput,
  }),
  output: ItemWithRevision,
  examples: [
    {
      input: {
        itemId: '01900000-0000-7000-8000-000000000001',
        baseRevisionId: '01900000-0000-7000-8000-000000000002',
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
          { path: 'document.locales', message: `content.locale.still-live:${s.locale}` },
        ]);
    return writeRevision(ctx, item, finalize(ctx, document, document.blocks));
  },
});

export const getItem = defineUseCase({
  name: 'content.item.get',
  kind: 'query',
  description:
    'Get an item with its publication state and one revision: the latest, or revisionId if given.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, revisionId: z.string().uuid().optional() }),
  output: ItemWithRevision,
  resource: { uriTemplate: 'mycel://content/{itemId}' },
  examples: [{ input: { itemId: '01900000-0000-7000-8000-000000000001' } }],
  async handler(ctx, { itemId, revisionId }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const revision = await ctx.content.revision(itemId, revisionId ?? item.latestRevisionId);
    if (!revision) throw notFound('revision');
    return { item: toContentItem(item), revision };
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
    after: z.string().uuid().optional(),
    limit: Limit,
  }),
  output: z.object({ items: z.array(ContentItem), next: z.string().uuid().nullable() }),
  examples: [{ input: { type: 'article' } }],
  async handler(ctx, { type, slug, after, limit }) {
    const page = await ctx.content.list({ type, slug }, after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { items: page.rows.map(toContentItem), next: page.next };
  },
});

export const listRevisions = defineUseCase({
  name: 'content.item.revisions',
  kind: 'query',
  description: 'List the revisions of an item newest first, with who saved each and when.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: ItemId, after: z.string().uuid().optional(), limit: Limit }),
  output: z.object({ revisions: z.array(RevisionSummary), next: z.string().uuid().nullable() }),
  examples: [{ input: { itemId: '01900000-0000-7000-8000-000000000001' } }],
  async handler(ctx, { itemId, after, limit }) {
    if (!(await ctx.content.get(itemId))) throw notFound('content item');
    const page = await ctx.content.revisions(itemId, after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { revisions: page.rows, next: page.next };
  },
});

export const diffRevisions = defineUseCase({
  name: 'content.item.diff',
  kind: 'query',
  description:
    'Compare two revisions of one item as a list of changed paths with the value before and after.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({
    itemId: ItemId,
    fromRevisionId: z.string().uuid(),
    toRevisionId: z.string().uuid(),
  }),
  output: z.object({
    changes: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })),
  }),
  examples: [
    {
      input: {
        itemId: '01900000-0000-7000-8000-000000000001',
        fromRevisionId: '01900000-0000-7000-8000-000000000002',
        toRevisionId: '01900000-0000-7000-8000-000000000003',
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
  revisionId: z.string().uuid(),
  locale: Locale,
});
const exampleTarget = {
  itemId: '01900000-0000-7000-8000-000000000001',
  revisionId: '01900000-0000-7000-8000-000000000002',
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
