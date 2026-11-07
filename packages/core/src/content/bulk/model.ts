// A bounded, immutable editorial proposal (ADR 028). Commands are closed data, never names of
// use cases to invoke. Execution is a later operation; a preview grants no future authority.
import { z } from 'zod';
import { Actor } from '../../principal.js';
import { Locale } from '../../i18n/locale.js';
import { ContentDocument, ContentDocumentInput, LocalePublication } from '../model.js';

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
