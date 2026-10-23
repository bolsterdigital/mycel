// Form definitions are data referenced from a block (ADR 010 rule 1). The probe ships one kind
// (`signup`) and two field types (`email`, `consent`); the vocabulary grows by registry entry.

import { z } from 'zod';
import { Locale, localized } from '../i18n/locale.js';

const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

export const EmailField = z.object({
  type: z.literal('email'),
  name: FieldName,
  label: localized(z.string().min(1)),
  required: z.boolean(),
});

/** A checkbox whose label is the consent text; `consentTextVersion` on the form is the evidence. */
export const ConsentField = z.object({
  type: z.literal('consent'),
  name: FieldName,
  label: localized(z.string().min(1)),
  required: z.literal(true),
});

export const FormField = z.discriminatedUnion('type', [EmailField, ConsentField]);
export type FormField = z.infer<typeof FormField>;

export const FormDefinition = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('signup'),
    /** The consent scope a signup adds to (ADR 010 rule 6: a list is a consent scope). */
    list: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    fields: z.array(FormField).min(1),
    submitLabel: localized(z.string().min(1)),
    thankYou: localized(z.string().min(1)),
    /** Which consent text the visitor saw; travels with the event as consent evidence (ADR 003). */
    consentTextVersion: z.string().min(1),
    /** Minimum seconds between rendering and submitting; faster is treated as a bot. */
    minFillSeconds: z.number().int().min(0).max(60).default(3),
  })
  .refine((f) => f.fields.filter((x) => x.type === 'email').length === 1, {
    message: 'forms.signup.needs-one-email-field',
  })
  .refine((f) => f.fields.some((x) => x.type === 'consent'), {
    message: 'forms.signup.needs-consent-field',
  });
export type FormDefinition = z.infer<typeof FormDefinition>;

/** Raw values as a front received them: strings from HTML forms, booleans from JSON clients. */
export const RawValues = z.record(z.union([z.string(), z.boolean()]));

export const SubmitInput = z.object({
  formId: z.string().uuid(),
  values: RawValues,
  locale: Locale,
  /** The page the form was on, for provenance and the supporter event's `source_site`. */
  pageUrl: z.string().url().optional(),
  /** Spam signals the public front collects; required for anonymous principals. */
  spam: z
    .object({
      honeypot: z.string().optional(),
      startedToken: z.string().optional(),
    })
    .optional(),
});
export type SubmitInput = z.infer<typeof SubmitInput>;

export const SubmitResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), submissionId: z.string().uuid() }),
  z.object({
    status: z.literal('invalid'),
    /** `message` is an i18n key (ADR 007); fronts translate it into the visitor's locale. */
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
  }),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['spam', 'too-fast', 'rate-limited']),
    message: z.string(),
  }),
]);
export type SubmitResult = z.infer<typeof SubmitResult>;

export interface Submission {
  id: string;
  formId: string;
  values: Record<string, string | boolean>;
  locale: string;
  pageUrl: string | null;
  ipHash: string | null;
  createdAt: Date;
  /**
   * The consent evidence as the visitor saw it, copied from the form when they submitted: the
   * list they asked to join and the version of the consent text. `mailing.confirm` reads these,
   * never the form's current definition, so a later edit of the form (#11) cannot change what a
   * click confirms (ADR 003, ADR 010 rule 5).
   */
  list: string;
  consentTextVersion: string;
  /** When the double opt-in was confirmed with the button on the page; null until then. */
  confirmedAt: Date | null;
}
