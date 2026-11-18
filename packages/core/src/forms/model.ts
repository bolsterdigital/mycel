// Form definitions are data referenced from a block (ADR 010). Submissions retain the
// definition they validated, rather than interpreting old input through a later edit.

import { z } from 'zod';
import { Locale, localized, pickAny } from '../i18n/locale.js';

import { FormField, FieldValue, validFieldReferences } from './fields.js';
export { FormField } from './fields.js';

/**
 * What a form is for. `donation` (MY-252 PR 2) also starts a payment: its one `amount` field is
 * the gift, and an accepted submission returns where the visitor pays. `membership` (MY-254 PR 4)
 * buys the paid tier it names (`tierId`) at the tier's price for the interval the visitor picks;
 * it has no amount field, since nobody types the price of a membership.
 */
export const FormKind = z.enum(['signup', 'contact', 'petition', 'rsvp', 'donation', 'membership']);
export type FormKind = z.infer<typeof FormKind>;

/** Kinds whose ticked consent field joins the form's list (a donor may also subscribe). */
export const JOINING_KINDS: readonly FormKind[] = ['signup', 'petition', 'donation', 'membership'];

/** Kinds whose accepted submission opens a payment. */
export const PAYING_KINDS: readonly FormKind[] = ['donation', 'membership'];

/** The field that holds the gift of a donation form. */
export const donationAmountField = (form: Pick<FormDefinition, 'fields'>) =>
  form.fields.find((f) => f.type === 'amount');

export const FormDefinition = z
  .object({
    id: z.string().guid(),
    /** Editorial metadata only; absent on legacy definitions to preserve their fingerprints. */
    name: localized(z.string().trim().min(1).max(200)).optional(),
    kind: FormKind,
    /** The consent scope a signup adds to (ADR 010 rule 6: a list is a consent scope). */
    list: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    fields: z.array(FormField).min(1).max(64),
    submitLabel: localized(z.string().min(1)),
    thankYou: localized(z.string().min(1)),
    /** Which consent text the visitor saw; travels with the event as consent evidence (ADR 003). */
    consentTextVersion: z.string().min(1),
    /** Minimum seconds between rendering and submitting; faster is treated as a bot. */
    minFillSeconds: z.number().int().min(0).max(60).default(3),
    /** A membership form only: the paid tier it sells (MY-254 PR 4). */
    tierId: z.string().guid().optional(),
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
  // The gift is one amount the visitor always gives: no second one to choose between, none that
  // a condition can switch off.
  .refine(
    (f) =>
      f.kind !== 'donation' ||
      (f.fields.filter((x) => x.type === 'amount').length === 1 &&
        f.fields.some((x) => x.type === 'amount' && x.required && !x.activeWhen)),
    { message: 'forms.donation.needs-one-amount-field' }
  )
  // Giving monthly or yearly starts a subscription, which only a donation form does.
  .refine(
    (f) =>
      f.kind === 'donation' ||
      !f.fields.some((x) => x.type === 'amount' && x.intervals?.some((i) => i !== 'once')),
    { message: 'forms.amount.intervals-donation-only' }
  )
  // A membership form names the tier it sells, and only it does; its price is the tier's.
  .refine((f) => (f.kind === 'membership') === (f.tierId !== undefined), {
    message: 'forms.membership.needs-tier',
  })
  .refine((f) => f.kind !== 'membership' || !f.fields.some((x) => x.type === 'amount'), {
    message: 'forms.membership.no-amount-field',
  })
  .refine((f) => f.fields.some((x) => x.type === 'email' && x.required && !x.activeWhen), {
    message: 'forms.needs-active-required-email',
  });
export type FormDefinition = z.infer<typeof FormDefinition>;

/** A readable authoring label, without changing legacy definitions or submission pins. */
export function formDefinitionName(form: FormDefinition, locale: string, fallback = 'en'): string {
  return pickAny(form.name ?? {}, locale, fallback) ?? form.list;
}

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
   * A donation form only: where the payment provider sends the visitor back, with `{token}` where
   * their return token goes (`donation.create`).
   */
  returnUrl: z.string().url().max(2000).optional(),
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
  z.object({
    status: z.literal('accepted'),
    submissionId: z.string().guid(),
    /** A donation form: where the visitor pays now; null when the provider settled at once. */
    checkoutUrl: z.string().url().nullable().optional(),
    /** A donation form: the token of the visitor's return page. */
    token: z.string().optional(),
  }),
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
    reason: z.enum(['spam', 'too-fast', 'rate-limited', 'recipient-limited', 'unavailable']),
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
  /**
   * When the consent double opt-in was confirmed, by Mycel's link or an external owner; null
   * until then. Confirmed consent only: feeds, observations and providers read it as such.
   */
  confirmedAt: Date | null;
  /**
   * When the address confirmed its signature on a campaign's form (ADR 033 rule 7); null until
   * then and on every other form. Optional so a submission built before 0052 still type-checks.
   */
  participationConfirmedAt?: Date | null;
  /** Null only on historical submissions made before versioned evaluation was introduced. */
  evaluation: {
    supporterLifecycleId?: string;
    /**
     * The campaign this submission takes part in (ADR 033 rule 3), decided inside the submission
     * transaction; its confirmation records the participation.
     */
    campaignId?: string;
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
