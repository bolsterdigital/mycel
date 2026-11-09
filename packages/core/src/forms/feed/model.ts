// Private feeds pin an approved connection and typed field ids, never visitor-selected URLs.
// Rejected: provider-specific mappings or executable expressions in the public form definition.
import { z } from 'zod';
import { FieldPredicate, FieldValue } from '../fields.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const FormFeed = z
  .object({
    id: Id,
    formId: z.string().guid(),
    enabled: z.boolean(),
    connectionId: z.string().guid().nullable(),
    connectionVersion: z.number().int().positive().nullable(),
    scope: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    confirmationOwner: z.literal('mycel'),
    when: FieldPredicate.optional(),
    mapping: z
      .array(z.object({ fieldId: Id, target: Id }).strict())
      .min(1)
      .max(64),
  })
  .strict()
  .refine((f) => new Set(f.mapping.map((m) => m.target)).size === f.mapping.length);
export type FormFeed = z.infer<typeof FormFeed>;
export const FormFeedSettings = z
  .object({ feeds: z.array(FormFeed).max(1024) })
  .strict()
  .refine((s) => new Set(s.feeds.map((f) => f.id)).size === s.feeds.length);
export type FormFeedSettings = z.infer<typeof FormFeedSettings>;
export const FeedActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), id: z.string() }),
  z.object({ kind: z.literal('api-key'), id: z.string() }),
  z.object({ kind: z.literal('system'), id: z.string() }),
]);
export const FormFeedState = z.object({
  version: z.number().int().nonnegative(),
  value: FormFeedSettings,
  actor: FeedActor.nullable(),
});
export type FormFeedState = z.infer<typeof FormFeedState>;
export interface PinnedFormFeed {
  businessId: string;
  version: string;
  feed: FormFeed;
  actor: z.infer<typeof FeedActor>;
}
export const FORM_FEED_SOURCE = 'form.feed';
export const FormFeedPayload = z
  .object({
    category: z.literal(FORM_FEED_SOURCE),
    data: z
      .object({
        submissionId: z.string().guid(),
        formId: z.string().guid(),
        feedId: Id,
        formVersion: z.string().min(1),
        mappingVersion: z.string().min(1),
        fields: z.record(Id, FieldValue),
        consent: z
          .object({
            scope: z.string(),
            owner: z.literal('mycel'),
            confirmedAt: z.string().datetime(),
            textVersion: z.string(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
