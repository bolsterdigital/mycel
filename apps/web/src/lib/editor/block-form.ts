// A block's props as a flat native form and back (brief content-editor § B, ADR 020 rule 5),
// driven by the field descriptions in the registry (`BLOCK_DEFINITIONS[type].fields`), so no
// block has a hand-built form. Names are `p.<path>` with the locale last (`p.title.nl`,
// `p.entries.0.answer.en`). The round trip is lossless: for every registry example,
// `propsFromForm(fields, formValues(fields, props, locales), base)` is the stored props again,
// with and without the base (block-form.test.ts).
//
// Editing one locale leaves the others alone: a locale the form does not carry keeps what the
// base had, and only the locales of the document are rendered. Rich text that is unchanged in
// the textarea keeps its stored JSON exactly, so opening and saving a form never rewrites a
// document into its canonical form. Validation stays core's: this builds the props as typed and
// the block schema decides (`content.item.set_props`, `content.item.insert`). Rejected: a Zod
// walk that derives the form from the schema (unions and refinements make it guesswork, see
// block-types.ts) and per-type Svelte forms (a new type would need a form before it is editable).

import type { BlockField } from '@mycel/core';
import { fromMarkdown, toMarkdown, type MarkdownError } from './markdown.js';

export type FormValues = Record<string, string>;
type Props = Record<string, unknown>;
type Localized = Record<string, unknown>;

/** What the form posted: values by name, and every name, for the emptiness of a list row. */
export interface Posted {
  get(name: string): string | null;
  names(): string[];
}

export const posted = (data: FormData): Posted => ({
  get: (name) => {
    const v = data.get(name);
    return typeof v === 'string' ? v : null;
  },
  names: () => [...new Set(data.keys())],
});

/** A rich text that could not be read, by field name. */
export interface FieldError extends MarkdownError {
  name: string;
}

const join = (prefix: string, key: string | number) => `${prefix}.${key}`;
const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';
const asRecord = (v: unknown): Localized =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Localized) : {};

/** Extra empty rows a list offers for adding entries. */
const spareRows = (field: Extract<BlockField, { kind: 'list' }>, rows: number) =>
  rows < field.max ? 1 : 0;

// --- props to form ------------------------------------------------------------------------------

function fieldValues(
  out: FormValues,
  field: BlockField,
  value: unknown,
  name: string,
  locales: readonly string[]
): void {
  switch (field.kind) {
    case 'text':
      if (field.localized)
        for (const l of locales) out[join(name, l)] = String(asRecord(value)[l] ?? '');
      else out[name] = typeof value === 'string' ? value : '';
      return;
    case 'caption':
      for (const l of locales) {
        const v = asRecord(value)[l];
        out[join(join(name, l), 'mode')] = v === undefined ? 'inherit' : v === '' ? 'hide' : 'own';
        out[join(name, l)] = typeof v === 'string' ? v : '';
      }
      return;
    case 'rich-text':
      for (const l of locales) {
        const doc = asRecord(value)[l];
        out[join(name, l)] = doc ? toMarkdown(doc as never) : '';
      }
      return;
    case 'media':
    case 'reference':
      out[name] = typeof value === 'string' ? value : '';
      return;
    case 'choice':
      out[name] = typeof value === 'string' ? value : (field.options[0] ?? '');
      return;
    case 'boolean':
      if (value === true) out[name] = 'on';
      return;
    case 'actions': {
      const actions = Array.isArray(value) ? (value as Props[]) : [];
      for (let i = 0; i < field.max; i++) {
        const a = actions[i];
        const row = join(name, i);
        for (const l of locales)
          out[join(join(row, 'label'), l)] = String(asRecord(a?.label)[l] ?? '');
        const target = asRecord(a?.target);
        out[join(row, 'target')] =
          target.kind === 'item' ? String(target.itemId) : target.kind === 'url' ? 'url' : '';
        out[join(row, 'url')] = target.kind === 'url' ? String(target.url) : '';
      }
      return;
    }
    case 'group':
      if (field.optional === 'omit' && value !== undefined) out[join(name, 'present')] = 'on';
      for (const f of field.fields)
        fieldValues(out, f, asRecord(value)[f.key], join(name, f.key), locales);
      return;
    case 'list': {
      const rows = Array.isArray(value) ? value : [];
      const count = rows.length + spareRows(field, rows.length);
      out[join(name, 'rows')] = String(count);
      for (let i = 0; i < count; i++)
        for (const f of field.fields)
          fieldValues(out, f, asRecord(rows[i])[f.key], join(join(name, i), f.key), locales);
      return;
    }
  }
}

/** The form values of a block's props, for the document's locales. */
export function formValues(
  fields: readonly BlockField[],
  props: Props | undefined,
  locales: readonly string[]
): FormValues {
  const out: FormValues = {};
  for (const f of fields) fieldValues(out, f, props?.[f.key], join('p', f.key), locales);
  return out;
}

// --- form to props ------------------------------------------------------------------------------

/** `undefined` means: leave the key out. */
type Read = (field: BlockField, base: unknown, name: string) => unknown;

/** A localised map: each posted locale set or removed, every other locale as the base had it. */
function localizedFrom(
  form: Posted,
  base: unknown,
  name: string,
  each: (value: string, locale: string, before: unknown) => unknown,
  optional?: 'omit' | 'null'
): unknown {
  const out: Localized = { ...asRecord(base) };
  for (const l of Object.keys({ ...out, ...localesIn(form, name) })) {
    const v = form.get(join(name, l));
    if (v === null) continue;
    const next = each(v, l, out[l]);
    if (next === undefined) delete out[l];
    else out[l] = next;
  }
  if (Object.keys(out).length) return out;
  return optional === 'omit' ? undefined : optional === 'null' ? null : out;
}

/** The locales the form carries for a localised field: `<name>.<locale>` without a deeper key. */
function localesIn(form: Posted, name: string): Record<string, true> {
  const found: Record<string, true> = {};
  for (const n of form.names()) {
    if (!n.startsWith(`${name}.`)) continue;
    const rest = n.slice(name.length + 1);
    const locale = rest.split('.')[0]!;
    if (/^[a-z]{2,3}(-[A-Z]{2})?$/.test(locale)) found[locale] = true;
  }
  return found;
}

function reader(form: Posted, errors: FieldError[]): Read {
  const read: Read = (field, base, name) => {
    switch (field.kind) {
      case 'text': {
        if (field.localized)
          return localizedFrom(
            form,
            base,
            name,
            (v) => (isEmpty(v) ? undefined : v),
            field.optional
          );
        const v = form.get(name);
        if (v === null) return base;
        if (!isEmpty(v)) return v;
        return field.optional === 'omit' ? undefined : field.optional === 'null' ? null : '';
      }
      case 'caption':
        return localizedFrom(
          form,
          base,
          name,
          (v, l) => {
            const mode = form.get(join(join(name, l), 'mode'));
            if (mode === 'inherit') return undefined;
            return mode === 'hide' || isEmpty(v) ? '' : v;
          },
          'omit'
        );
      case 'rich-text':
        return localizedFrom(form, base, name, (v, l, before) => {
          if (isEmpty(v)) return undefined;
          // Unchanged text keeps the stored document exactly.
          if (before && toMarkdown(before as never) === v.replace(/\r\n?/g, '\n')) return before;
          const read = fromMarkdown(v);
          if (read.ok) return read.doc;
          errors.push({ name: join(name, l), ...read.error });
          return before;
        });
      case 'media':
      case 'reference':
      case 'choice': {
        const v = form.get(name);
        return v === null ? base : v;
      }
      case 'boolean':
        return form.get(name) === 'on';
      case 'actions': {
        const before = Array.isArray(base) ? (base as Props[]) : [];
        const out: Props[] = [];
        for (let i = 0; i < field.max; i++) {
          const row = join(name, i);
          const target = form.get(join(row, 'target'));
          if (target === null) {
            if (before[i]) out.push(before[i]!);
            continue;
          }
          const label = localizedFrom(form, before[i]?.label, join(row, 'label'), (v) =>
            isEmpty(v) ? undefined : v
          );
          if (target === '' && !Object.keys(asRecord(label)).length) continue;
          out.push({
            label,
            target:
              target === 'url' || target === ''
                ? { kind: 'url', url: form.get(join(row, 'url')) ?? '' }
                : { kind: 'item', itemId: target },
          });
        }
        return out;
      }
      case 'group': {
        if (field.optional === 'omit' && form.get(join(name, 'present')) !== 'on') return undefined;
        const value = groupFrom(field.fields, asRecord(base), name, read);
        if (field.optional === 'null' && Object.values(value).every((v) => v === '' || v == null))
          return null;
        return value;
      }
      case 'list': {
        const rows = Number(form.get(join(name, 'rows')) ?? NaN);
        const before = Array.isArray(base) ? base : [];
        if (!Number.isInteger(rows)) return base;
        const out: Props[] = [];
        for (let i = 0; i < Math.min(rows, field.max + 1); i++) {
          const row = join(name, i);
          const typed = form
            .names()
            .filter((n) => n.startsWith(`${row}.`))
            .some((n) => !isEmpty(form.get(n)) && !n.endsWith('.mode'));
          if (!typed) continue;
          out.push(groupFrom(field.fields, asRecord(before[i]), row, read));
        }
        return out;
      }
    }
  };
  return read;
}

function groupFrom(fields: readonly BlockField[], base: Props, name: string, read: Read): Props {
  const out: Props = {};
  for (const f of fields) {
    const v = read(f, base[f.key], join(name, f.key));
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/**
 * The props a form posted, on top of `base` (the stored props, or nothing for a new block).
 * `errors` lists rich text that could not be read; the caller refuses the save when there are.
 */
export function propsFromForm(
  fields: readonly BlockField[],
  form: Posted,
  base?: Props
): { props: Props; errors: FieldError[] } {
  const errors: FieldError[] = [];
  return { props: groupFrom(fields, base ?? {}, 'p', reader(form, errors)), errors };
}

/** A `Posted` over plain values, for tests and for re-rendering what was typed. */
export const postedValues = (values: FormValues): Posted => ({
  get: (name) => values[name] ?? null,
  names: () => Object.keys(values),
});
