// Native controls decode to the same typed registry inputs as HTTP and MCP. Rejected: raw JSON
// editors or trusting hidden inputs for tenant context, recipients or confirmed consent.
import { UseCaseError, type FormDefinition, type FormField } from '@mycel/core';
import { text } from '../admin/admin-actions.js';
import type { FieldPredicate } from '@mycel/core';

const invalid = () => {
  throw new UseCaseError('invalid_input', 'invalid form controls');
};
export const checked = (data: FormData, key: string) => text(data, key) === 'on';
export function predicate(data: FormData, prefix: string): FieldPredicate | undefined {
  const mode = text(data, `${prefix}.mode`);
  if (!mode) return undefined;
  const atoms = Array.from({ length: 8 }, (_, i) => {
    const fieldId = text(data, `${prefix}.${i}.field`);
    if (!fieldId) return null;
    const op = text(data, `${prefix}.${i}.op`);
    if (op === 'present') return { op, fieldId } as const;
    if (op !== 'equals' && op !== 'not-equals') return invalid();
    const raw = text(data, `${prefix}.${i}.value`),
      type = text(data, `${prefix}.${i}.type`);
    if (type === 'boolean' && !['true', 'false'].includes(raw)) return invalid();
    if (type === 'number' && (!raw.trim() || !Number.isFinite(Number(raw)))) return invalid();
    const value = type === 'boolean' ? raw === 'true' : type === 'number' ? Number(raw) : raw;
    return { op: op as 'equals' | 'not-equals', fieldId, value };
  }).filter((x) => x !== null);
  if (!atoms.length) return invalid();
  if (mode === 'atom') return atoms.length === 1 ? atoms[0] : invalid();
  if (mode !== 'and' && mode !== 'or') return invalid();
  return { op: mode, conditions: atoms };
}
export function localizedInput(data: FormData, prefix: string, old: Record<string, string> = {}) {
  const value = { ...old };
  for (const locale of ['nl', 'en']) {
    const copy = text(data, `${prefix}.${locale}`);
    if (copy) value[locale] = copy;
    else delete value[locale];
  }
  return value;
}
export function fieldInput(data: FormData, old?: FormField): FormField {
  const type = text(data, 'type');
  const field = {
    ...old,
    id: old ? (old.id ?? old.name) : text(data, 'id'),
    name: text(data, 'name'),
    type,
    label: localizedInput(data, 'label', old?.label),
    help: Object.keys(localizedInput(data, 'help', old?.help)).length
      ? localizedInput(data, 'help', old?.help)
      : undefined,
    required: checked(data, 'required'),
    activeWhen: predicate(data, 'active'),
    requiredWhen: predicate(data, 'requiredWhen'),
    inactivePolicy: text(data, 'inactivePolicy') || 'discard',
  };
  // The core discriminated schema removes irrelevant properties after a type change.
  return {
    ...field,
    ...(['number', 'amount'].includes(type)
      ? {
          min: text(data, 'min') ? Number(text(data, 'min')) : undefined,
          max: text(data, 'max') ? Number(text(data, 'max')) : undefined,
        }
      : {}),
    ...(['text', 'textarea', 'phone'].includes(type)
      ? { maxLength: text(data, 'maxLength') ? Number(text(data, 'maxLength')) : undefined }
      : {}),
    ...(['choice', 'multiple-choice'].includes(type)
      ? {
          options: text(data, 'options')
            .split('\n')
            .filter(Boolean)
            .map((row) => {
              const [value, nl, en] = row.split('|');
              const previous =
                old && 'options' in old ? old.options.find((o) => o.value === value)?.label : {};
              return { value, label: { ...previous, nl: nl || value, en: en || value } };
            }),
        }
      : {}),
    ...(type === 'hidden' ? { value: text(data, 'hiddenValue') } : {}),
  } as FormField;
}
export function updateDefinition(data: FormData, form: FormDefinition): FormDefinition {
  const command = text(data, 'command'),
    id = text(data, 'fieldId');
  const fields = [...form.fields],
    index = fields.findIndex((f) => (f.id ?? f.name) === id);
  if (command === 'field') {
    if (id && index < 0) return invalid();
    const value = fieldInput(data, index >= 0 ? fields[index] : undefined);
    if (index >= 0) fields[index] = value;
    else fields.push(value);
  } else if (command === 'remove') {
    if (index < 0) return invalid();
    fields.splice(index, 1);
  } else if (command === 'up' || command === 'down') {
    const target = index + (command === 'up' ? -1 : 1);
    if (index < 0 || target < 0 || target >= fields.length) return invalid();
    [fields[index], fields[target]] = [fields[target]!, fields[index]!];
  } else if (command === 'settings')
    return {
      ...form,
      kind: text(data, 'kind') as FormDefinition['kind'],
      list: text(data, 'list'),
      consentTextVersion: text(data, 'consentTextVersion'),
      submitLabel: localizedInput(data, 'submitLabel', form.submitLabel),
      thankYou: localizedInput(data, 'thankYou', form.thankYou),
    };
  else return invalid();
  return { ...form, fields };
}
