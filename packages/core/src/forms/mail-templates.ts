// Resolve inheritance once for preview and planning. Only bounded plain-text field placeholders
// are supported; submitted HTML is escaped when rendered, never interpreted as a template.
import { UseCaseError } from '../errors.js';
import { t } from '../i18n/index.js';
import { fieldId, type FieldValue } from './fields.js';
import type { FormDefinition } from './model.js';
import { ResolvedFormMail, type FormMailConfig, type FormMailSettings } from './mail-model.js';

type Ref = NonNullable<FormMailConfig['confirmation']>;
const placeholders = /\{\{field:([a-z][a-z0-9_-]{0,63})\}\}/g;
export function mailValues(form: FormDefinition, values: Record<string, FieldValue>) {
  return Object.fromEntries(
    form.fields
      .filter((f) => Object.hasOwn(values, f.name))
      .map((f) => [fieldId(f), values[f.name]!])
  );
}
export function resolveFormMail(
  settings: FormMailSettings,
  ref: Ref,
  form: FormDefinition,
  locale: string,
  values: Record<string, FieldValue>,
  kind: 'confirmation' | 'notification' | 'receipt' = 'notification',
  preserveTokens = false
): ResolvedFormMail {
  const template = ref.templateId ? settings.templates.find((t) => t.id === ref.templateId) : null;
  if (ref.templateId && !template)
    throw new UseCaseError('invalid_input', 'forms.mail.template.missing');
  const byId = mailValues(form, values);
  const sources: ResolvedFormMail['sources'] = { subject: 'platform', text: 'platform' };
  const resolved = { subject: '', text: '', sources };
  for (const key of ['subject', 'text'] as const) {
    let copy = ref.override?.[key]?.[locale];
    if (copy !== undefined) sources[key] = 'local';
    else {
      copy = template?.[key][locale];
      if (copy !== undefined) sources[key] = 'tenant';
      else if (kind === 'confirmation')
        copy = t(
          locale,
          key === 'subject' ? 'mail.form.confirmation.subject' : 'mail.form.confirmation.text'
        );
      else
        copy = t(
          locale,
          kind === 'receipt'
            ? key === 'subject'
              ? 'mail.form.receipt.subject'
              : 'mail.form.receipt.text'
            : key === 'subject'
              ? 'mail.form.notification.subject'
              : 'mail.form.notification.text'
        );
    }
    for (const match of copy.matchAll(placeholders)) {
      if (!form.fields.some((f) => fieldId(f) === match[1]))
        throw new UseCaseError('invalid_input', 'forms.mail.field.missing');
    }
    resolved[key] = preserveTokens
      ? copy
      : copy.replace(placeholders, (_, id: string) => {
          const value = Object.hasOwn(byId, id) ? byId[id] : '';
          const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          // An address field or textarea must never inject a subject header or make an unbounded subject.
          return key === 'subject' ? text.replace(/[\r\n]/g, ' ').slice(0, 100) : text;
        });
  }
  const parsed = ResolvedFormMail.safeParse(resolved);
  if (!parsed.success) throw new UseCaseError('invalid_input', 'forms.mail.copy.invalid');
  return parsed.data;
}
