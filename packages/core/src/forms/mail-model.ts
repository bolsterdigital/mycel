// Mail configuration is private tenant data, separate from the publicly rendered form.
// Rejected: recipient mappings from submitted values, or resolving mutable templates on retry.
import { z } from 'zod';
import { Locale, localized } from '../i18n/locale.js';
import { EmailAddress } from '../util/email.js';
import { FieldPredicate, validPredicateReferences } from './fields.js';
import type { FormDefinition } from './model.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const Subject = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\r\n]/.test(s));
const Text = z.string().trim().min(1).max(20000);
const Copy = z.object({ subject: localized(Subject), text: localized(Text) }).strict();
export const FormMailTemplate = Copy.extend({ id: Id }).strict();
export type FormMailTemplate = z.infer<typeof FormMailTemplate>;
const TemplateRef = z
  .object({
    templateId: Id.optional(),
    // A local locale/value overrides only that locale/value, not the whole inherited template.
    override: z
      .object({
        subject: z.record(Locale, Subject).optional(),
        text: z.record(Locale, Text).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const FormMailAction = z
  .object({
    id: Id,
    enabled: z.boolean(),
    kind: z.enum(['notification', 'receipt']),
    when: FieldPredicate.optional(),
    // Notifications use the approved fixed set. Receipts always use the validated email field.
    recipients: z.array(EmailAddress).max(8),
    template: TemplateRef,
  })
  .strict()
  .refine((a) => (a.kind === 'notification' ? a.recipients.length > 0 : !a.recipients.length))
  .refine((a) => new Set(a.recipients).size === a.recipients.length);
export type FormMailAction = z.infer<typeof FormMailAction>;
export const FormMailConfig = z
  .object({
    formId: z.string().guid(),
    enabled: z.boolean(),
    confirmation: TemplateRef.optional(),
    actions: z.array(FormMailAction).max(8),
  })
  .strict()
  .refine((c) => new Set(c.actions.map((a) => a.id)).size === c.actions.length)
  .refine((c) => c.actions.filter((a) => a.kind === 'receipt').length <= 1);
export type FormMailConfig = z.infer<typeof FormMailConfig>;
export const FormMailSettings = z
  .object({
    templates: z.array(FormMailTemplate).max(256),
    forms: z.array(FormMailConfig).max(1024),
  })
  .strict()
  .refine((s) => new Set(s.templates.map((t) => t.id)).size === s.templates.length)
  .refine((s) => new Set(s.forms.map((f) => f.formId)).size === s.forms.length);
export type FormMailSettings = z.infer<typeof FormMailSettings>;
export const FormMailState = z.object({
  version: z.number().int().nonnegative(),
  value: FormMailSettings,
});
export type FormMailState = z.infer<typeof FormMailState>;
export const EMPTY_FORM_MAIL: FormMailState = { version: 0, value: { templates: [], forms: [] } };

export const ResolvedFormMail = z.object({
  subject: Subject,
  text: Text,
  sources: z.object({
    subject: z.enum(['platform', 'tenant', 'local']),
    text: z.enum(['platform', 'tenant', 'local']),
  }),
});
export type ResolvedFormMail = z.infer<typeof ResolvedFormMail>;
export interface PinnedMailAction {
  actionId: string;
  version: string;
  eventId: string;
  recipient: string;
}

/** Use the same typed predicate validation as fields, after all fields have been validated. */
export function validMailPredicate(form: FormDefinition, action: FormMailAction): boolean {
  return !action.when || validPredicateReferences(action.when, form.fields, true);
}
