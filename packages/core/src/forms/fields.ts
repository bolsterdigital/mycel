// Typed fields and bounded predicates share one server vocabulary. References only point back
// in definition order, so invalid or discarded input cannot activate a later field or consent.
// Rejected: evaluating predicates over the raw browser payload or accepting arbitrary expressions.
import { z } from 'zod';
import { localized } from '../i18n/locale.js';
import { EmailAddress } from '../util/email.js';

const PHONE_PATTERN = /^\+?[\d\s().-]{3,40}$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

export function fieldPattern(type: string): string | undefined {
  return type === 'email'
    ? z.regexes.email.source
    : type === 'phone'
      ? PHONE_PATTERN.source
      : ['number', 'amount'].includes(type)
        ? NUMBER_PATTERN.source
        : undefined;
}

const FieldId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const Atom = z.discriminatedUnion('op', [
  z.object({
    op: z.enum(['equals', 'not-equals']),
    fieldId: FieldId,
    value: z.union([z.string().max(4000), z.boolean(), z.number().finite()]),
  }),
  z.object({ op: z.literal('present'), fieldId: FieldId }),
]);
export const FieldPredicate = z.union([
  Atom,
  z.object({ op: z.enum(['and', 'or']), conditions: z.array(Atom).min(1).max(8) }),
]);
export type FieldPredicate = z.infer<typeof FieldPredicate>;

const common = {
  id: FieldId.optional(), // Legacy definitions acquire their original name as their stable id.
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,40}$/)
    .refine(
      (s) => !['formId', 'locale', 'website', '__proto__', 'constructor', 'prototype'].includes(s)
    ),
  label: localized(z.string().min(1).max(4000)),
  help: localized(z.string().max(4000)).optional(),
  required: z.boolean(),
  activeWhen: FieldPredicate.optional(),
  requiredWhen: FieldPredicate.optional(),
  inactivePolicy: z.enum(['discard', 'reject']).optional(),
};
const option = z.object({ value: z.string().min(1).max(100), label: localized(z.string().min(1)) });
const options = z
  .array(option)
  .min(1)
  .max(50)
  .refine((a) => new Set(a.map((o) => o.value)).size === a.length);
export const FormField = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('email') }),
  z.object({
    ...common,
    type: z.enum(['text', 'textarea', 'phone']),
    maxLength: z.number().int().min(1).max(10000).optional(),
  }),
  z.object({
    ...common,
    type: z.enum(['number', 'amount']),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.object({ ...common, type: z.literal('date') }),
  z.object({ ...common, type: z.enum(['choice', 'multiple-choice']), options }),
  z.object({ ...common, type: z.enum(['checkbox', 'consent']) }),
  z.object({ ...common, type: z.literal('hidden'), value: z.string().max(4000) }),
]);
export type FormField = z.infer<typeof FormField>;
export const fieldId = (field: FormField): string => field.id ?? field.name;
export const FieldValue = z.union([
  z.string().max(10000),
  z.boolean(),
  z.number().finite(),
  z.array(z.string().max(100)).max(50),
]);
export type FieldValue = z.infer<typeof FieldValue>;

export function predicateMatches(
  predicate: FieldPredicate,
  values: Readonly<Record<string, FieldValue>>
): boolean {
  if ('conditions' in predicate)
    return predicate.op === 'and'
      ? predicate.conditions.every((p) => predicateMatches(p, values))
      : predicate.conditions.some((p) => predicateMatches(p, values));
  if (!Object.hasOwn(values, predicate.fieldId)) return false;
  const value = values[predicate.fieldId];
  // Missing/inactive/invalid never satisfies not-equals either.
  if (value === undefined) return false;
  if (predicate.op === 'present')
    return value !== '' && value !== false && (!Array.isArray(value) || value.length > 0);
  const equal = Array.isArray(value)
    ? value.includes(String(predicate.value))
    : value === predicate.value;
  return predicate.op === 'equals' ? equal : !equal;
}

/** Broken references, type mismatches and cycles are refused before a definition is usable. */
export function validFieldReferences(fields: FormField[]): boolean {
  const prior = new Map<string, FormField>();
  const names = new Set<string>();
  for (const field of fields) {
    if (prior.has(fieldId(field)) || names.has(field.name)) return false;
    if (
      'min' in field &&
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      return false;
    for (const predicate of [field.activeWhen, field.requiredWhen]) {
      if (!predicate) continue;
      if (!validPredicateReferences(predicate, [...prior.values()])) return false;
    }
    prior.set(fieldId(field), field);
    names.add(field.name);
  }
  return true;
}

/** Shared typed references; action predicates may read validated active consent as a boolean. */
export function validPredicateReferences(
  predicate: FieldPredicate,
  fields: readonly FormField[],
  allowConsent = false
): boolean {
  for (const atom of 'conditions' in predicate ? predicate.conditions : [predicate]) {
    const target = fields.find((f) => fieldId(f) === atom.fieldId);
    if (!target || target.type === 'hidden' || (!allowConsent && target.type === 'consent'))
      return false;
    if (atom.op === 'present') continue;
    const kind = ['checkbox', 'consent'].includes(target.type)
      ? 'boolean'
      : ['number', 'amount'].includes(target.type)
        ? 'number'
        : 'string';
    if (typeof atom.value !== kind) return false;
    if ('options' in target && !target.options.some((o) => o.value === atom.value)) return false;
  }
  return true;
}

/** One pass in dependency order; predicates consume only earlier validated, active values. */
export function evaluateFields(fields: readonly FormField[], raw: Record<string, FieldValue>) {
  const values: Record<string, FieldValue> = {};
  const byId: Record<string, FieldValue> = {};
  const errors: { field: string; message: string }[] = [];
  const activeFieldIds: string[] = [],
    requiredFieldIds: string[] = [],
    discardedFieldIds: string[] = [];
  let email = '';
  let consent = false;
  for (const field of fields) {
    const id = fieldId(field);
    if (field.activeWhen && !predicateMatches(field.activeWhen, byId)) {
      const inactive = raw[field.name];
      if (inactive !== undefined) {
        discardedFieldIds.push(id);
        if (
          field.inactivePolicy === 'reject' &&
          inactive !== '' &&
          !(Array.isArray(inactive) && inactive.length === 0)
        )
          errors.push({ field: field.name, message: 'forms.error.inactive' });
      }
      continue;
    }
    activeFieldIds.push(id);
    const required =
      field.required || !!(field.requiredWhen && predicateMatches(field.requiredWhen, byId));
    if (required) requiredFieldIds.push(id);
    const input = field.type === 'hidden' ? field.value : raw[field.name];
    const text = typeof input === 'string' ? input.trim() : '';
    let value: FieldValue | undefined;
    let error: string | undefined;
    if (field.type === 'checkbox' || field.type === 'consent') {
      value = input === true || input === 'on' || input === 'true' || input === '1';
      if (
        input !== undefined &&
        ![true, false, 'on', 'true', 'false', '1', '0', ''].includes(input as string | boolean)
      )
        error = 'forms.error.value';
      else if (required && !value)
        error = field.type === 'consent' ? 'forms.error.consent.required' : 'forms.error.required';
    } else if (field.type === 'multiple-choice') {
      const choices = Array.isArray(input) ? input : text ? [text] : [];
      value = [...new Set(choices)];
      if (input !== undefined && typeof input !== 'string' && !Array.isArray(input))
        error = 'forms.error.value';
      else if (required && !value.length) error = 'forms.error.required';
      else if (choices.some((v) => !field.options.some((o) => o.value === v)))
        error = 'forms.error.value';
    } else if (input !== undefined && typeof input !== 'string' && typeof input !== 'number') {
      error = 'forms.error.value';
    } else if (!text && typeof input !== 'number') {
      if (required) error = 'forms.error.required';
    } else if (field.type === 'email') {
      const parsed = EmailAddress.safeParse(text);
      if (parsed.success) value = parsed.data;
      else error = 'forms.error.email.invalid';
    } else if (field.type === 'number' || field.type === 'amount') {
      const number =
        typeof input === 'number' ? input : NUMBER_PATTERN.test(text) ? Number(text) : NaN;
      if (
        !Number.isFinite(number) ||
        (field.min !== undefined && number < field.min) ||
        (field.max !== undefined && number > field.max) ||
        (field.type === 'amount' &&
          (number < 0 || Math.abs(number * 100 - Math.round(number * 100)) > 1e-7))
      )
        error = 'forms.error.value';
      else value = number;
    } else if (field.type === 'date') {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        !Number.isFinite(Date.parse(text)) ||
        new Date(text).toISOString().slice(0, 10) !== text
      )
        error = 'forms.error.value';
      else value = text;
    } else if (field.type === 'choice') {
      if (!field.options.some((o) => o.value === text)) error = 'forms.error.value';
      else value = text;
    } else {
      const max =
        'maxLength' in field
          ? (field.maxLength ?? (field.type === 'textarea' ? 10000 : 4000))
          : 4000;
      if (!text || text.length > max || (field.type === 'phone' && !PHONE_PATTERN.test(text)))
        error = 'forms.error.value';
      else value = text;
    }
    if (error) errors.push({ field: field.name, message: error });
    else if (value !== undefined) {
      values[field.name] = byId[id] = value;
      if (field.type === 'email') email = String(value);
      if (field.type === 'consent' && value === true) consent = true;
    }
  }
  return { values, email, consent, errors, activeFieldIds, requiredFieldIds, discardedFieldIds };
}
