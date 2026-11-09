// Form definitions are data referenced from a block (ADR 010). Submissions retain the
// definition they validated, rather than interpreting old input through a later edit.

import { z } from 'zod';
import { Locale, localized } from '../i18n/locale.js';

import { FormField, FieldValue, validFieldReferences } from './fields.js';
export { FormField } from './fields.js';

export const FormDefinition = z
  .object({
    id: z.string().guid(),
    kind: z.enum(['signup', 'contact', 'petition', 'rsvp']),
    /** The consent scope a signup adds to (ADR 010 rule 6: a list is a consent scope). */
    list: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    fields: z.array(FormField).min(1).max(64),
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
  .refine((f) => f.kind !== 'signup' || f.fields.some((x) => x.type === 'consent'), {
    message: 'forms.signup.needs-consent-field',
  })
  .refine((f) => f.fields.filter((x) => x.type === 'consent').length <= 1, {
    message: 'forms.needs-one-consent-owner',
  })
  .refine((f) => validFieldReferences(f.fields), { message: 'forms.fields.invalid-references' })
  .refine((f) => f.fields.some((x) => x.type === 'email' && x.required && !x.activeWhen), {
    message: 'forms.needs-active-required-email',
  });
export type FormDefinition = z.infer<typeof FormDefinition>;

/** Preserve a legacy name as the initial id before any authoring change can rename it. */
export function parseFormDefinition(input: unknown): FormDefinition {
  const form = FormDefinition.parse(input);
  return { ...form, fields: form.fields.map((f) => ({ ...f, id: f.id ?? f.name })) };
}

/** Raw values as a front received them: strings from HTML forms, booleans from JSON clients. */
export const RawValues = z.record(z.string(), FieldValue);

export const SubmitInput = z.object({
  formId: z.string().guid(),
  formVersion: z.string().min(1).max(128).optional(),
  values: RawValues,
  locale: Locale,
  /** The page the form was on, for provenance and the supporter event's `source_site`. */
  pageUrl: z.string().url().optional(),
  /**
   * Spam signals the public front collects; required for anonymous principals. `honeypot` is
   * the posted value of the hidden field, absent when the post had no such field: an anonymous
   * post without it is refused as spam (the handler, not the schema, since integrations omit it).
   */
  spam: z
    .object({
      honeypot: z.string().optional(),
      startedToken: z.string().optional(),
      /** The ALTCHA solution (base64 JSON, `forms/proof.ts`); absent without JavaScript. */
      proof: z.string().max(4000).optional(),
    })
    .optional(),
});
export type SubmitInput = z.infer<typeof SubmitInput>;

export const SubmitResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), submissionId: z.string().guid() }),
  z.object({
    status: z.literal('invalid'),
    /** `message` is an i18n key (ADR 007); fronts translate it into the visitor's locale. */
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
  }),
  z.object({
    status: z.literal('rejected'),
    /**
     * `recipient-limited`: this address already got a confirmation from this form in the last
     * 24 hours. A public front shows it like `spam` (the thank-you page), so nobody learns
     * whether an address was used; an authenticated integration sees why nothing happened.
     */
    reason: z.enum(['spam', 'too-fast', 'rate-limited', 'recipient-limited']),
    message: z.string(),
  }),
]);
export type SubmitResult = z.infer<typeof SubmitResult>;

export interface Submission {
  id: string;
  formId: string;
  values: Record<string, z.infer<typeof FieldValue>>;
  locale: string;
  pageUrl: string | null;
  ipHash: string | null;
  createdAt: Date;
  /**
   * The consent evidence as the visitor saw it, copied from the form when they submitted: the
   * list they asked to join and the version of the consent text. `mailing.opt_in.confirm` reads these,
   * never the form's current definition, so a later edit of the form (#11) cannot change what a
   * click confirms (ADR 003, ADR 010 rule 5).
   */
  list: string;
  consentTextVersion: string;
  /** When the double opt-in was confirmed with the button on the page; null until then. */
  confirmedAt: Date | null;
  /** Null only on historical submissions made before versioned evaluation was introduced. */
  evaluation: {
    confirmationMail?: { version: string; copy: import('./mail-model.js').ResolvedFormMail };
    feedActions?: import('./feed/model.js').PinnedFormFeed[];
    mailActions?: import('./mail-model.js').PinnedMailAction[];
    version: string;
    definition: FormDefinition;
    activeFieldIds: string[];
    requiredFieldIds: string[];
    discardedFieldIds: string[];
  } | null;
}
