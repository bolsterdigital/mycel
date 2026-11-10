// A block's props as a flat native form and back (brief content-editor § B, ADR 020 rule 5),
// driven by the field descriptions in the registry (`BLOCK_DEFINITIONS[type].fields`), so no
// block has a hand-built form. Names are `p.<path>` with the locale last (`p.title.nl`,
// `p.entries.0.answer.en`). The round trip is lossless: for every registry example,
// `propsFromForm(fields, formValues(fields, props, locales), base)` is the stored props again,
// with and without the base (block-form.test.ts).
//
// Editing one locale leaves the others alone: a locale the form does not carry keeps what the
// base had, and only the locales asked for are rendered (the edit screen asks for one, #66 PR 4).
// A list row whose shown locale is emptied stays while another locale still has text in it. Rich text that is unchanged in
// the textarea keeps its stored JSON exactly, so opening and saving a form never rewrites a
// document into its canonical form. Validation stays core's: this builds the props as typed and
// the block schema decides (`content.block.update`, `content.block.insert`). Rejected: a Zod
// walk that derives the form from the schema (unions and refinements make it guesswork, see
// block-types.ts) and per-type Svelte forms (a new type would need a form before it is editable).

import { RichTextDoc, isBlankDoc, type BlockField } from '@mycel/core';
import { imageAltProps } from '../admin/hero-alt/hero-alt.js';
import { fromTiptap } from './article-document.js';
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
/** The hidden field of a list row that names the stored row it shows. */
const FROM = 'from';
const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';
const asRecord = (v: unknown): Localized =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Localized) : {};

/**
 * Extra empty rows a list offers: up to its minimum, else one for adding an entry. Without the
 * minimum a new block of cards offers one row where its schema asks two, and cannot be saved.
 */
const spareRows = (field: Extract<BlockField, { kind: 'list' }>, rows: number, button = false) =>
  Math.max(field.min - rows, rows < field.max && !button ? 1 : 0);

/** How the form offers new rows: a top-level list named here has an add button, no spare row. */
export interface FormOptions {
  addButton?: readonly string[];
}

// --- props to form ------------------------------------------------------------------------------

function fieldValues(
  out: FormValues,
  field: BlockField,
  value: unknown,
  name: string,
  locales: readonly string[],
  button = false
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
        // A blank document from an old revision shows as what it is: nothing typed.
        out[join(name, l)] = doc && !isBlankDoc(doc) ? toMarkdown(doc as never) : '';
      }
      return;
    case 'media':
    case 'reference':
    case 'date':
      out[name] = typeof value === 'string' ? value : '';
      return;
    case 'choice':
      out[name] = typeof value === 'string' ? value : (field.initial ?? field.options[0] ?? '');
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
      const count = rows.length + spareRows(field, rows.length, button);
      out[join(name, 'rows')] = String(count);
      for (let i = 0; i < count; i++) {
        // Which stored row this one is, so a row moved or removed in the form keeps the locales
        // the form does not carry; empty is a new row.
        out[join(join(name, i), FROM)] = i < rows.length ? String(i) : '';
        for (const f of field.fields)
          fieldValues(out, f, asRecord(rows[i])[f.key], join(join(name, i), f.key), locales);
      }
      return;
    }
  }
}

/** The form values of a block's props, for the document's locales. */
export function formValues(
  fields: readonly BlockField[],
  props: Props | undefined,
  locales: readonly string[],
  options: FormOptions = {}
): FormValues {
  const out: FormValues = {};
  for (const f of fields)
    fieldValues(
      out,
      f,
      props?.[f.key],
      join('p', f.key),
      locales,
      options.addButton?.includes(f.key) ?? false
    );
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

/** One locale of a rich-text field: the enhanced editor's document, else the Markdown. */
function richTextFrom(
  form: Posted,
  name: string,
  v: string,
  l: string,
  before: unknown,
  errors: FieldError[]
): unknown {
  const enhanced = form.get(`${join(name, l)}.editor`);
  if (enhanced) {
    try {
      return RichTextDoc.parse(fromTiptap(JSON.parse(enhanced)));
    } catch {
      errors.push({ name: join(name, l), message: 'editor.markdown.invalid', line: 1 });
      return before;
    }
  }
  if (isEmpty(v)) return undefined;
  // Unchanged text keeps the stored document exactly.
  if (before && toMarkdown(before as never) === v.replace(/\r\n?/g, '\n')) return before;
  const read = fromMarkdown(v);
  if (read.ok) return read.doc;
  errors.push({ name: join(name, l), ...read.error });
  return before;
}

/** Whether a posted field is an enhanced editor with no words in it: nothing typed in a row. */
function blankEditor(name: string, value: string | null): boolean {
  if (!name.endsWith('.editor') || !value) return false;
  try {
    return isBlankDoc(fromTiptap(JSON.parse(value)));
  } catch {
    return false;
  }
}

function reader(form: Posted, errors: FieldError[]): Read {
  /** A localised value under `name` with a locale the form does not carry (#66 PR 4). */
  const untouched = (value: unknown, name: string) =>
    Object.entries(asRecord(value)).some(
      ([l, x]) => x !== undefined && form.get(join(name, l)) === null
    );
  /**
   * Whether the stored row `base` has text in a locale the form does not show: a form of one
   * locale then keeps the row, even when its own locale's fields are empty.
   */
  const elsewhere = (fields: readonly BlockField[], base: unknown, name: string): boolean =>
    fields.some((f) => {
      const value = asRecord(base)[f.key];
      const at = join(name, f.key);
      switch (f.kind) {
        case 'text':
          return f.localized && untouched(value, at);
        case 'caption':
        case 'rich-text':
          return untouched(value, at);
        case 'actions':
          return (Array.isArray(value) ? (value as Props[]) : []).some((a, i) =>
            untouched(a.label, join(join(at, i), 'label'))
          );
        case 'group':
          return elsewhere(f.fields, value, at);
        case 'list':
          return (Array.isArray(value) ? value : []).some((row, i) =>
            elsewhere(f.fields, row, join(at, i))
          );
        default:
          return false;
      }
    });
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
          const doc = richTextFrom(form, name, v, l, before, errors);
          // Emptied is absent, as for a text field: the other locale shows through, and readiness
          // sees a missing translation.
          return isBlankDoc(doc) ? undefined : doc;
        });
      case 'reference': {
        const value = form.get(name);
        if (value === null) return base;
        return isEmpty(value) && field.optional === 'omit'
          ? undefined
          : isEmpty(value) && field.optional === 'null'
            ? null
            : value;
      }
      case 'media':
      case 'date':
      case 'choice': {
        const v = form.get(name);
        if (v === null) return base;
        // An absent optional choice shows as its default; left there, it stays absent as stored.
        const fallback = field.kind === 'choice' && (field.initial ?? field.options[0]);
        if (field.kind === 'choice' && field.optional && base === undefined && v === fallback)
          return undefined;
        return v;
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
          const stored = storedRow(before, form.get(join(row, FROM)), i);
          const preset = choiceDefaults(field.fields, row);
          const typed = form
            .names()
            .filter((n) => n.startsWith(`${row}.`) && n !== join(row, FROM))
            .some(
              (n) =>
                !isEmpty(form.get(n)) &&
                form.get(n) !== preset.get(n) &&
                !n.endsWith('.mode') &&
                !blankEditor(n, form.get(n)) &&
                // An editor that posts a document overrides its textarea, which still holds the
                // words it loaded. An untouched editor posts nothing: the textarea is the value.
                isEmpty(form.get(`${n}.editor`))
            );
          if (!typed && !elsewhere(field.fields, stored, row)) continue;
          out.push(groupFrom(field.fields, asRecord(stored), row, read));
        }
        return out;
      }
    }
  };
  return read;
}

/**
 * The stored row a posted row edits: the one its `from` names, none for a new row (empty), and
 * the one at its own place for a form without the field (an older tab). Rejected: matching rows
 * by position only, which hands a moved row's other locales to the row that took its place.
 */
function storedRow(before: readonly unknown[], from: string | null, at: number): unknown {
  if (from === null) return before[at];
  if (!/^\d+$/.test(from)) return undefined;
  return before[Number(from)];
}

/** What each choice of a spare row shows before anyone touches it: no sign the row was typed in. */
function choiceDefaults(
  fields: readonly BlockField[],
  name: string,
  out = new Map<string, string>()
) {
  for (const f of fields)
    if (f.kind === 'choice') out.set(join(name, f.key), f.initial ?? f.options[0] ?? '');
    else if (f.kind === 'group') choiceDefaults(f.fields, join(name, f.key), out);
  return out;
}

/**
 * The props of a group of fields read from the form. One rule crosses fields: an image use
 * (`mediaId` beside a localised `alt`) whose image changed keeps no stored alt text of a locale
 * the form does not carry, because it described the old picture; the header's image does the same
 * (content-admin.ts). The locale on screen is what was posted. Rejected: keeping it, which shows
 * an old description as present in a language nobody looked at since the image changed.
 */
function groupFrom(fields: readonly BlockField[], base: Props, name: string, read: Read): Props {
  const out: Props = {};
  for (const f of fields) {
    const swapped =
      f.key === 'alt' &&
      typeof base.mediaId === 'string' &&
      typeof out.mediaId === 'string' &&
      out.mediaId !== base.mediaId &&
      fields.some((m) => m.key === 'mediaId' && m.kind === 'media');
    const v = read(f, swapped ? undefined : base[f.key], join(name, f.key));
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

/**
 * Stored form values with what a post typed on top, for the names under `prefix`. A list the post
 * carries is taken whole: a stored row it removed or moved must not show through at its old place.
 */
export function typedOver(
  stored: FormValues,
  typed: Record<string, unknown>,
  prefix: string
): FormValues {
  const mine = Object.entries(typed).filter(
    (e): e is [string, string] => e[0].startsWith(prefix) && typeof e[1] === 'string'
  );
  if (!mine.length) return stored;
  const lists = mine.filter(([k]) => k.endsWith('.rows')).map(([k]) => k.slice(0, -'rows'.length));
  const kept = Object.entries(stored).filter(([k]) => !lists.some((l) => k.startsWith(l)));
  return { ...Object.fromEntries(kept), ...Object.fromEntries(mine) };
}

// --- rearranging a list in the form -------------------------------------------------------------

export const LIST_MOVES = ['add', 'remove', 'earlier', 'later'] as const;
export type ListMove = (typeof LIST_MOVES)[number];

/**
 * A list's rows rearranged in the posted values, before anything is saved: a row added at
 * the end, one removed, or one swapped with its neighbour, within the list's own bounds. Every
 * name under a row moves with it, its `from` too, so the save reads each row onto the stored row
 * it came from. Names of other fields stay as they are. Rejected: a save per step, which stores
 * half-typed rows and refuses a row whose title is not typed yet.
 */
type Values = Record<string, string | string[]>;

export function arrangeRows(
  values: Readonly<Values>,
  name: string,
  move: ListMove,
  index: number,
  bounds: { min: number; max: number }
): Values {
  const rowsKey = join(name, 'rows');
  const rows = Number(values[rowsKey]);
  if (!Number.isInteger(rows) || rows < 0) return { ...values };
  const out: Values = {};
  const target = (i: number): number | null => {
    if (move === 'remove') return i === index ? null : i > index ? i - 1 : i;
    if (move === 'earlier' && index > 0)
      return i === index ? index - 1 : i === index - 1 ? index : i;
    if (move === 'later' && index < rows - 1)
      return i === index ? index + 1 : i === index + 1 ? index : i;
    return i;
  };
  const allowed =
    (move === 'add' && rows < bounds.max) ||
    (move === 'remove' && rows > bounds.min && index >= 0 && index < rows) ||
    move === 'earlier' ||
    move === 'later';
  if (!allowed) return { ...values };
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(`${name}.`) || key === rowsKey) {
      out[key] = value;
      continue;
    }
    const rest = key.slice(name.length + 1);
    const dot = rest.indexOf('.');
    const at = Number(dot < 0 ? rest : rest.slice(0, dot));
    if (!Number.isInteger(at) || dot < 0) {
      out[key] = value;
      continue;
    }
    const to = target(at);
    if (to !== null) out[`${name}.${to}${rest.slice(dot)}`] = value;
  }
  const count = move === 'add' ? rows + 1 : move === 'remove' ? rows - 1 : rows;
  out[rowsKey] = String(count);
  if (move === 'add') out[join(join(name, rows), FROM)] = '';
  return out;
}

/**
 * The standalone image form makes an empty description decorative, like the document header.
 * Apply only after its normal localised merge, and only when that control was shown. Rejected:
 * normalising every image-use group, which would weaken the gallery and legacy hero contracts.
 */
export function imageAltFromForm(props: Props, form: Posted): Props {
  if (form.get('imageAltShown') !== '1') return props;
  const alt = form.get('imageAltClear') === 'on' ? null : props.alt;
  return { ...props, ...imageAltProps(alt) };
}

/**
 * The form field a core issue is about: `document.blocks.<i>.props.<path>` of a save is the field
 * of the block at `i`, `block.props.<path>` of an insert the new block's; '' for any other path.
 */
export function blockIssueName(path: string, blocks: readonly { id: string }[]): string {
  const stored = /^(?:document\.)?blocks\.(\d+)\.props(\..+)?$/.exec(path);
  if (stored) {
    const block = blocks[Number(stored[1])];
    return block ? `b.${block.id}.p${stored[2] ?? ''}` : '';
  }
  const added = /^block\.props(\..+)?$/.exec(path);
  return added ? `new.p${added[1] ?? ''}` : '';
}

/**
 * Save and publication refusals mark the same controls. Publication returns readiness paths
 * instead of native form names; keeping it only in the publication panel left a missing image
 * description closed and unmarked after a refused publish. Rejected: inferring a refusal from
 * readiness alone, which would mark unfinished drafts as errors before anyone publishes.
 */
export function editorFieldIssues(
  form: unknown,
  blocks: readonly { id: string }[]
): { name: string; list?: string; copy: string }[] {
  type Issue = { name: string; list?: string; copy: string };
  const refusal = form as {
    fieldIssues?: Issue[];
    issues?: { path: string; copy: string }[];
  } | null;
  return [
    ...(refusal?.fieldIssues ?? []),
    ...(refusal?.issues ?? []).flatMap((issue) => {
      const name = blockIssueName(issue.path, blocks);
      return name ? [{ name, copy: issue.copy }] : [];
    }),
  ];
}
