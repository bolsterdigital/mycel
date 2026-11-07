// A bounded, immutable editorial proposal (ADR 028). Commands are closed data, never names of
// use cases to invoke. Execution is a later operation; a preview grants no future authority.
import { z } from 'zod';
import { Actor } from '../../principal.js';
import { Locale } from '../../i18n/locale.js';
import { ContentDocument, ContentDocumentInput, ContentItem, LocalePublication } from '../model.js';

const Id = z.string().guid();
export const BulkOperation = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('save'),
      document: ContentDocumentInput,
      publish: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal('publish'), revisionId: Id }).strict(),
  z.object({ kind: z.literal('unpublish') }).strict(),
]);
export const BulkSelection = z
  .object({
    itemId: Id,
    baseRevisionId: Id,
    operation: BulkOperation,
  })
  .strict();
export const PrepareBulk = z
  .object({
    locale: Locale,
    items: z
      .array(BulkSelection)
      .min(1)
      .max(100)
      .refine(
        (items) => new Set(items.map((i) => i.itemId)).size === items.length,
        'content.bulk.duplicate'
      ),
  })
  .strict();
export const BulkProblem = z
  .object({
    code: z.enum([
      'not_found',
      'forbidden',
      'invalid_input',
      'conflict',
      'limit_exceeded',
      'suspended',
    ]),
    issues: z.array(
      z.object({
        path: z.string(),
        message: z.string(),
        params: z.record(z.string(), z.string()).optional(),
      })
    ),
  })
  .strict();
export const BulkPreview = z
  .object({
    status: z.enum(['ready', 'unchanged', 'awaiting_editor', 'refused']),
    candidate: ContentDocument.nullable(),
    changes: z.array(
      z.object({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })
    ),
    merge: z.object({ baseRevisionId: Id, latestRevisionId: Id }).strict().nullable(),
    problems: z.array(BulkProblem),
  })
  .strict();
export const BulkPlanItem = z
  .object({
    selection: BulkSelection,
    // Only resolved references enter the composite foreign keys. An unknown requested id remains
    // opaque request data, with the same refusal as an id that belongs to another tenant.
    resolvedItemId: Id.nullable(),
    baseRevisionId: Id.nullable(),
    latestRevisionId: Id.nullable(),
    publication: z.array(LocalePublication),
    preview: BulkPreview,
  })
  .strict();
export const BulkPlan = z
  .object({
    id: Id,
    version: z.literal(1),
    actor: Actor,
    locale: Locale,
    createdAt: z.string().datetime({ offset: true }),
    items: z.array(BulkPlanItem).min(1).max(100),
  })
  .strict();
export type BulkPlan = z.infer<typeof BulkPlan>;
export type BulkPlanItem = z.infer<typeof BulkPlanItem>;
export type BulkPreview = z.infer<typeof BulkPreview>;

// One slot per request is a deliberately measurable transaction bound. A caller follows `next`
// through the frozen selection, keeping the same ordinal after an uncertain response.
export const BulkStep = z
  .object({
    planId: Id,
    version: z.literal(1),
    ordinal: z.number().int().min(0).max(99).default(0),
  })
  .strict();
export const BulkPhase = z.enum(['apply', 'undo']);
export const BulkResult = z
  .object({
    status: z.enum(['unchanged', 'changed', 'awaiting_editor', 'refused', 'conflict', 'undone']),
    retryable: z.boolean(),
    actor: Actor,
    at: z.string().datetime({ offset: true }),
    before: ContentItem.nullable(),
    after: ContentItem.nullable(),
    savedRevisionId: Id.nullable(),
    publishedRevisionId: Id.nullable(),
    publicationChanged: z.boolean(),
    merge: BulkPreview.shape.merge,
    problems: z.array(BulkProblem),
  })
  .strict();
export type BulkResult = z.infer<typeof BulkResult>;
export type BulkPhase = z.infer<typeof BulkPhase>;
export const BulkProgress = z
  .object({
    planId: Id,
    version: z.literal(1),
    phase: BulkPhase,
    ordinal: z.number().int(),
    result: BulkResult,
    next: z.number().int().nullable(),
  })
  .strict();
export const BulkReport = z
  .object({
    planId: Id,
    undoRequested: z.boolean(),
    items: z.array(
      z
        .object({
          itemId: Id,
          apply: BulkResult.nullable(),
          undo: BulkResult.nullable(),
        })
        .strict()
    ),
    fullyUndone: z.boolean(),
  })
  .strict();
