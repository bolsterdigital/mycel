// Freeze the dry run in the same tenant transaction as its reads. Rejected: a client-side loop
// whose report is lost on disconnect and whose selection changes when a list filter changes.
import { z } from 'zod';
import '../ports.js';
import { notFound, UseCaseError } from '../../errors.js';
import { can } from '../../principal.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { ContentDocument, readinessIssues } from '../model.js';
import { diffDocuments } from '../diff.js';
import { prepareItemSave, referenceIssues, toContentItem } from '../service.js';
import { preserveTranslationReview } from '../translation-review.js';
import { BulkPlan, PrepareBulk, type BulkPlanItem } from './model.js';
import { withoutErasedCredits, withoutErasedPlanCredits } from '../people/erasure.js';

function need(ctx: TransactionContext, capability: 'content:write' | 'content:publish') {
  return can(ctx.principal, capability)
    ? []
    : [
        {
          code: 'forbidden' as const,
          issues: [
            {
              path: 'operation',
              message: 'content.bulk.capability-required',
              params: { capability },
            },
          ],
        },
      ];
}

async function previewItem(
  ctx: TransactionContext,
  selection: z.infer<typeof PrepareBulk>['items'][number],
  locale: string
): Promise<BulkPlanItem> {
  const result: BulkPlanItem = {
    selection,
    resolvedItemId: null,
    baseRevisionId: null,
    latestRevisionId: null,
    publication: [],
    preview: { status: 'refused', candidate: null, changes: [], merge: null, problems: [] },
  };
  const preview = result.preview;
  try {
    const item = await ctx.content.lock(selection.itemId);
    if (!item) throw notFound('content item');
    result.resolvedItemId = item.id;
    result.latestRevisionId = item.latestRevisionId;
    result.publication = toContentItem(item).publication;
    const base = await ctx.content.revision(item.id, selection.baseRevisionId);
    if (!base)
      throw new UseCaseError('conflict', 'unknown base revision', [
        { path: 'baseRevisionId', message: 'content.revision.conflict' },
      ]);
    result.baseRevisionId = base.id;
    const latest = await ctx.content.revision(item.id, item.latestRevisionId);
    if (!latest) throw notFound('revision');
    const op = selection.operation;
    const publishing = op.kind === 'publish' || (op.kind === 'save' && op.publish);
    preview.problems.push(...need(ctx, op.kind === 'save' ? 'content:write' : 'content:publish'));
    if (op.kind === 'save' && op.publish) preview.problems.push(...need(ctx, 'content:publish'));
    let candidate = latest.document;
    if (op.kind === 'save') {
      const save = await prepareItemSave(ctx, item, base.id, op.document);
      candidate = ContentDocument.parse(preserveTranslationReview(latest.document, save.next));
      preview.merge = save.merge;
    } else if (op.kind === 'publish') {
      const revision = await ctx.content.revision(item.id, op.revisionId);
      if (!revision) throw notFound('revision');
      // A reviewed publication candidate must also be the current draft. No implicit repin of
      // an old revision while a newer draft exists.
      if (revision.id !== item.latestRevisionId || base.id !== item.latestRevisionId)
        throw new UseCaseError('conflict', 'publication candidate changed', [
          { path: 'operation.revisionId', message: 'content.revision.conflict' },
        ]);
      candidate = revision.document;
    }
    // ADR 034 rule 4 (N2 of the merge review): the frozen candidate and its changes hold no name
    // beside an erased person's credit; the reference check passes the registered id (rule 7).
    candidate = await withoutErasedCredits(ctx, candidate);
    const frozen = await withoutErasedPlanCredits(
      ctx,
      candidate,
      op.kind === 'save' ? diffDocuments(latest.document, candidate) : []
    );
    candidate = frozen.candidate;
    const refs = await referenceIssues(ctx, candidate);
    if (refs.length) throw new UseCaseError('invalid_input', 'invalid references', refs);
    preview.candidate = candidate;
    preview.changes = frozen.changes;
    const state = item.publication.find((p) => p.locale === locale);
    if (!state)
      preview.problems.push({
        code: 'invalid_input',
        issues: [{ path: 'locale', message: 'content.publish.locale-not-in-document' }],
      });
    if (publishing) {
      const issues = readinessIssues(candidate, locale);
      if (issues.length) preview.problems.push({ code: 'invalid_input', issues });
    }
    const waits =
      publishing &&
      (preview.merge !== null ||
        (!!state?.publishedRevisionId && state.publishedRevisionId !== item.latestRevisionId));
    if (state?.scheduleId && (publishing || op.kind === 'unpublish'))
      preview.problems.push({
        code: 'conflict',
        issues: [{ path: 'publication', message: 'content.bulk.scheduled' }],
      });
    const unchanged =
      op.kind === 'save' && !op.publish
        ? canonicalJson(candidate) === canonicalJson(latest.document)
        : op.kind === 'unpublish'
          ? !state?.publishedRevisionId
          : op.kind === 'publish' && state?.publishedRevisionId === op.revisionId;
    preview.status = preview.problems.length
      ? 'refused'
      : waits
        ? 'awaiting_editor'
        : unchanged
          ? 'unchanged'
          : 'ready';
  } catch (error) {
    if (error instanceof UseCaseError)
      preview.problems.push({ code: error.code, issues: error.issues });
    else if (error instanceof z.ZodError)
      preview.problems.push({
        code: 'invalid_input',
        issues: [{ path: 'document', message: 'content.bulk.unreadable' }],
      });
    else throw error;
  }
  return result;
}

export const createBulk = defineUseCase({
  name: 'content.bulk.create',
  kind: 'command',
  description:
    'Freeze a dry run for at most 100 explicit content items; records proposals and current capability or publication problems without changing content.',
  requires: 'content:read',
  consumes: null,
  input: PrepareBulk,
  output: BulkPlan,
  examples: [
    {
      input: {
        locale: 'nl',
        items: [
          { itemId: exampleId(1), baseRevisionId: exampleId(2), operation: { kind: 'unpublish' } },
        ],
      },
    },
  ],
  async handler(ctx, input) {
    const items: BulkPlanItem[] = [];
    // All content locks in a stable order before any media lock: no cross-plan lock inversion.
    for (const selected of [...input.items].sort((a, b) => a.itemId.localeCompare(b.itemId)))
      await ctx.content.lock(selected.itemId);
    for (const selection of input.items) {
      const item = await previewItem(ctx, selection, input.locale);
      // ADR 034 rule 4: the caller's document is a stored copy as well.
      items.push({ ...item, selection: await withoutErasedCredits(ctx, item.selection) });
    }
    const plan: BulkPlan = {
      id: ctx.ids.next(),
      version: 1,
      actor: ctx.principal.actor,
      locale: input.locale,
      createdAt: ctx.clock.now().toISOString(),
      items,
    };
    await ctx.bulkPlans.insert(plan);
    return plan;
  },
});
export const getBulk = defineUseCase({
  name: 'content.bulk.get',
  kind: 'query',
  description:
    'Read an immutable content bulk plan and its dry-run results in the current tenant; its recorded permissions are historical, not authority to execute.',
  requires: 'content:read',
  input: z.object({ planId: z.string().guid() }).strict(),
  output: BulkPlan,
  resource: { uriTemplate: 'mycel://content-bulk/{planId}' },
  examples: [{ input: { planId: exampleId(1) } }],
  async handler(ctx, { planId }) {
    const plan = await ctx.bulkPlans.get(planId);
    if (!plan) throw notFound('bulk plan');
    return plan;
  },
});
