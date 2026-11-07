// Each request commits one frozen slot with its result. Rejected: nested invokers or one large
// transaction, which respectively lose atomic evidence or let one item block the whole report.
import { z } from 'zod';
import { notFound, UseCaseError } from '../../errors.js';
import { can } from '../../principal.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { exampleId } from '../../util/ids.js';
import { publish, unpublish, draftLocale } from '../lifecycle.js';
import { ContentDocument, readinessIssues } from '../model.js';
import type { ItemRecord } from '../ports.js';
import {
  assertPublishable,
  assertReferences,
  prepareItemSave,
  requireBlockTypes,
  restoreRevision,
  toContentItem,
  writeRevision,
} from '../service.js';
import { preserveTranslationReview } from '../translation-review.js';
import {
  BulkStep,
  BulkProgress,
  BulkReport,
  type BulkPlan,
  type BulkPlanItem,
  type BulkPhase,
  type BulkResult,
} from './model.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function refuse(
  code: 'conflict' | 'invalid_input' | 'forbidden',
  path: string,
  message: string
): never {
  throw new UseCaseError(code, message, [{ path, message }]);
}
function requireCapability(
  ctx: TransactionContext,
  capability: 'content:write' | 'content:publish'
) {
  if (!can(ctx.principal, capability))
    refuse('forbidden', 'operation', `content.bulk.requires-${capability.split(':')[1]}`);
}
function empty(ctx: TransactionContext): BulkResult {
  return {
    status: 'unchanged',
    retryable: false,
    actor: ctx.principal.actor,
    at: ctx.clock.now().toISOString(),
    before: null,
    after: null,
    savedRevisionId: null,
    publishedRevisionId: null,
    publicationChanged: false,
    merge: null,
    problems: [],
  };
}
function failed(result: BulkResult, error: unknown): BulkResult {
  if (error instanceof z.ZodError)
    return {
      ...result,
      status: 'refused',
      problems: [
        {
          code: 'invalid_input',
          issues: [{ path: 'document', message: 'content.bulk.unreadable' }],
        },
      ],
    };
  if (!(error instanceof UseCaseError)) throw error;
  return {
    ...result,
    status: error.code === 'conflict' ? 'conflict' : 'refused',
    retryable: error.code === 'forbidden' || error.code === 'limit_exceeded',
    problems: [{ code: error.code, issues: error.issues }],
  };
}

// Preparation catches domain refusals before any mutation. Errors once writing starts escape
// to the unit of work, rolling content, media usages, result and audit back together.
async function prepareApply(
  ctx: TransactionContext,
  plan: BulkPlan,
  slot: BulkPlanItem,
  item: ItemRecord,
  result: BulkResult
) {
  const op = slot.selection.operation;
  requireCapability(ctx, op.kind === 'save' ? 'content:write' : 'content:publish');
  if (op.kind === 'save' && op.publish) requireCapability(ctx, 'content:publish');
  const previous = await ctx.content.revision(item.id, item.latestRevisionId);
  if (!previous) throw notFound('revision');
  if (
    !slot.preview.candidate ||
    slot.preview.problems.some((p) => p.code !== 'forbidden' && p.code !== 'limit_exceeded')
  )
    refuse('conflict', 'planId', 'content.bulk.new-plan-required');
  let candidate = previous.document;
  let provenance;
  if (op.kind === 'save') {
    // Start from the reviewed candidate, whose generated block ids are frozen. Re-merge that
    // candidate against the revision observed by the dry run, preserving later colleague work.
    if (!slot.latestRevisionId) throw notFound('revision');
    const save = await prepareItemSave(ctx, item, slot.latestRevisionId, slot.preview.candidate);
    candidate = ContentDocument.parse(preserveTranslationReview(previous.document, save.next));
    result.merge = save.merge ?? slot.preview.merge;
    provenance =
      save.provenance ?? (slot.preview.merge ? { merged: slot.preview.merge } : undefined);
  } else if (op.kind === 'publish') {
    if (item.latestRevisionId !== slot.latestRevisionId || op.revisionId !== item.latestRevisionId)
      refuse('conflict', 'operation.revisionId', 'content.bulk.new-plan-required');
    candidate = slot.preview.candidate;
  }
  await assertReferences(ctx, candidate);
  const state = item.publication.find((s) => s.locale === plan.locale);
  const observed = slot.publication.find((s) => s.locale === plan.locale);
  if (!state) refuse('invalid_input', 'locale', 'content.publish.locale-not-in-item');
  const wantsPublish = op.kind === 'publish' || (op.kind === 'save' && op.publish);
  let publication = state;
  if (op.kind === 'unpublish') {
    if (state.scheduleId || !same(toContentItem(item).publication, slot.publication))
      refuse('conflict', 'publication', 'content.bulk.publication-changed');
    publication = unpublish(state);
  } else if (wantsPublish) {
    const issues = readinessIssues(candidate, plan.locale);
    const waits =
      result.merge !== null ||
      item.latestRevisionId !== slot.latestRevisionId ||
      !same(candidate, slot.preview.candidate) ||
      !same(toContentItem(item).publication, slot.publication) ||
      !!state.scheduleId ||
      (!!observed?.publishedRevisionId && observed.publishedRevisionId !== slot.latestRevisionId);
    if (waits || issues.length) {
      result.status = 'awaiting_editor';
      result.problems = [
        {
          code: waits ? 'conflict' : 'invalid_input',
          issues: waits
            ? [{ path: 'publication', message: 'content.bulk.editor-review-required' }]
            : issues,
        },
      ];
    } else publication = publish(state, item.latestRevisionId, ctx.clock.now());
  }
  return { candidate, provenance, publication, wantsPublish, previous };
}

async function apply(
  ctx: TransactionContext,
  plan: BulkPlan,
  slot: BulkPlanItem
): Promise<BulkResult> {
  const result = empty(ctx);
  let item: ItemRecord;
  let prepared: Awaited<ReturnType<typeof prepareApply>>;
  try {
    if (!slot.resolvedItemId) throw notFound('content item');
    const found = await ctx.content.lock(slot.resolvedItemId);
    if (!found) throw notFound('content item');
    item = found;
    result.before = toContentItem(item);
    prepared = await prepareApply(ctx, plan, slot, item, result);
  } catch (error) {
    return failed(result, error);
  }
  const op = slot.selection.operation;
  const { candidate, provenance, previous, wantsPublish } = prepared;
  let { publication } = prepared;
  if (op.kind === 'save' && !same(candidate, previous.document)) {
    const saved = await writeRevision(ctx, item, candidate, {
      ...provenance,
      bulk: { runId: plan.id, phase: 'apply' },
    });
    result.savedRevisionId = saved.revision.id;
    item = (await ctx.content.get(item.id))!;
    if (wantsPublish && result.status !== 'awaiting_editor')
      publication = publish(
        item.publication.find((s) => s.locale === plan.locale)!,
        saved.revision.id,
        ctx.clock.now()
      );
  }
  if (op.kind !== 'save' || op.publish) {
    // The content lock is still held: no save can enter between the comparison and this pointer.
    if (result.status !== 'awaiting_editor') {
      item = {
        ...item,
        publication: item.publication.map((s) => (s.locale === plan.locale ? publication : s)),
      };
      await ctx.content.save(item);
    }
  }
  result.after = toContentItem(item);
  result.publicationChanged =
    result.status !== 'awaiting_editor' &&
    (op.kind !== 'save' || op.publish) &&
    !same(
      result.before!.publication.map(({ status: _s, hasUnpublishedChanges: _h, ...p }) => p),
      result.after.publication.map(({ status: _s, hasUnpublishedChanges: _h, ...p }) => p)
    );
  result.publishedRevisionId = result.publicationChanged ? publication.publishedRevisionId : null;
  if (result.status !== 'awaiting_editor')
    result.status = result.savedRevisionId || result.publicationChanged ? 'changed' : 'unchanged';
  return result;
}

async function undo(
  ctx: TransactionContext,
  plan: BulkPlan,
  slot: BulkPlanItem,
  applied: BulkResult | null
): Promise<BulkResult> {
  const result = empty(ctx);
  if (!applied?.after || (!applied.savedRevisionId && !applied.publicationChanged)) return result;
  let item: ItemRecord;
  let previous;
  try {
    if (applied.savedRevisionId) requireCapability(ctx, 'content:write');
    if (applied.publicationChanged) requireCapability(ctx, 'content:publish');
    const found = await ctx.content.lock(slot.resolvedItemId!);
    if (!found) throw notFound('content item');
    item = found;
    result.before = toContentItem(item);
    if (!same(result.before, applied.after))
      refuse('conflict', 'itemId', 'content.bulk.undo-intervening-change');
    previous = await ctx.content.revision(item.id, applied.before!.latestRevisionId);
    if (!previous) throw notFound('revision');
    if (applied.savedRevisionId) {
      requireBlockTypes(ctx, previous.document.blocks);
      await assertReferences(ctx, previous.document);
    }
    if (applied.publicationChanged) {
      for (const state of applied.before!.publication) {
        if (state.scheduleId) refuse('conflict', 'publication', 'content.bulk.scheduled');
        if (state.publishedRevisionId) {
          const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
          if (!revision) throw notFound('revision');
          await assertPublishable(ctx, revision.document, state.locale);
        }
      }
    }
  } catch (error) {
    return failed(result, error);
  }
  if (applied.savedRevisionId) {
    const restored = await restoreRevision(ctx, item, previous, {
      bulk: { runId: plan.id, phase: 'undo' },
    });
    result.savedRevisionId = restored.revision.id;
    item = (await ctx.content.get(item.id))!;
  }
  // A save can add/remove draft locales. Restore their exact pre-effect state as well, without
  // resurrecting any planning. Equality above guards offers, pins and every other locale too.
  item = {
    ...item,
    publication: applied.before!.publication.map((p) => ({
      ...draftLocale(p.locale),
      ...p,
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
      firstPublishedAt: p.firstPublishedAt ? new Date(p.firstPublishedAt) : null,
      scheduledFor: p.scheduledFor ? new Date(p.scheduledFor) : null,
      review: p.review ? { ...p.review, since: new Date(p.review.since) } : null,
    })),
  };
  await ctx.content.save(item);
  result.after = toContentItem(item);
  result.status = 'undone';
  result.publicationChanged = applied.publicationChanged;
  result.publishedRevisionId =
    item.publication.find((p) => p.locale === plan.locale)?.publishedRevisionId ?? null;
  return result;
}

function step(phase: BulkPhase) {
  return defineUseCase({
    name: `content.bulk.${phase === 'apply' ? 'resume' : 'withdraw'}`,
    kind: 'command',
    requires: 'content:read',
    input: BulkStep,
    output: BulkProgress,
    description:
      phase === 'apply'
        ? 'Apply or resume one frozen bulk slot per transaction; follow next through the selection and retry the same ordinal after a lost response; each effect checks current write and publish grants.'
        : 'Request undo for the entire run and restore one slot per transaction; follow next through all slots; later editing conflicts and successful slots are never repeated.',
    examples: [{ input: { planId: exampleId(1), version: 1, ordinal: 0 } }],
    async handler(ctx, { planId, version, ordinal }) {
      if (!(await ctx.bulkPlans.lock(planId))) throw notFound('bulk plan');
      const plan = await ctx.bulkPlans.get(planId);
      if (!plan) throw notFound('bulk plan');
      const slot = plan.items[ordinal];
      if (!slot || plan.version !== version)
        refuse('invalid_input', 'ordinal', 'content.bulk.invalid-slot');
      if (phase === 'undo') await ctx.bulkPlans.requestUndo(planId);
      else if (await ctx.bulkPlans.undoRequested(planId))
        refuse('conflict', 'planId', 'content.bulk.undo-requested');
      let result = await ctx.bulkPlans.result(planId, ordinal, phase);
      if (!result || result.retryable) {
        result =
          phase === 'apply'
            ? await apply(ctx, plan, slot)
            : await undo(ctx, plan, slot, await ctx.bulkPlans.result(planId, ordinal, 'apply'));
        await ctx.bulkPlans.record(planId, ordinal, phase, result);
      }
      return {
        planId,
        version,
        phase,
        ordinal,
        result,
        next: ordinal + 1 < plan.items.length ? ordinal + 1 : null,
      };
    },
  });
}
export const resumeBulk = step('apply');
export const withdrawBulk = step('undo');
export const checkBulk = defineUseCase({
  name: 'content.bulk.check',
  kind: 'query',
  requires: 'content:read',
  description:
    'Read every frozen slot and its durable apply and undo results, including partial restoration and slots not yet processed.',
  input: z.object({ planId: z.string().guid() }).strict(),
  output: BulkReport,
  examples: [{ input: { planId: exampleId(1) } }],
  async handler(ctx, { planId }) {
    const plan = await ctx.bulkPlans.get(planId);
    if (!plan) throw notFound('bulk plan');
    const items = [];
    for (let ordinal = 0; ordinal < plan.items.length; ordinal++)
      items.push({
        itemId: plan.items[ordinal]!.selection.itemId,
        apply: await ctx.bulkPlans.result(planId, ordinal, 'apply'),
        undo: await ctx.bulkPlans.result(planId, ordinal, 'undo'),
      });
    const undoRequested = await ctx.bulkPlans.undoRequested(planId);
    return {
      planId,
      undoRequested,
      items,
      fullyUndone:
        undoRequested &&
        items.every(
          (i) =>
            i.undo !== null &&
            ((!i.apply?.savedRevisionId && !i.apply?.publicationChanged) ||
              i.undo.status === 'undone')
        ),
    };
  },
});
