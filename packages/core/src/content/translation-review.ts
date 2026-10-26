// Translation review is monotone server state per item/locale (ADR 018, 021). Field paths are
// hints, never proof that text was deleted: editors can split, merge, rewrite and replace ids.
// Rejected: matching prose nodes or trusting client metadata to establish human approval.
import { UseCaseError } from '../errors.js';
import { BLOCK_DEFINITIONS, type BlockField } from './block-types.js';
import { localizedFields, type ContentDocument } from './model.js';

type Path = (string | number)[];
type JsonObject = Record<string | number, unknown>;

/** Stable object-key order, including mark attributes supplied in a different JSON order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

function erase(root: unknown, path: Path): void {
  const [key, ...rest] = path;
  if (key === undefined || !root || typeof root !== 'object') return;
  if (rest.length) erase((root as JsonObject)[key], rest);
  else delete (root as JsonObject)[key];
}

/** Every localized value, including paths and absence, from the validated registry projection. */
function projection(doc: ContentDocument, locale: string): string {
  return canonical(
    localizedFields(doc)
      .filter((field) => field.value[locale] !== undefined)
      .map((field) => [field.path, field.value[locale]])
  );
}

/** Remove only declared non-text controls. Unknown/new string fields fail closed. */
function eraseControls(props: unknown, fields: readonly BlockField[]): void {
  if (!props || typeof props !== 'object') return;
  const record = props as JsonObject;
  for (const field of fields) {
    if (field.kind === 'choice' || field.kind === 'media' || field.kind === 'reference')
      delete record[field.key];
    else if (field.kind === 'group') eraseControls(record[field.key], field.fields);
    else if (field.kind === 'list' && Array.isArray(record[field.key]))
      for (const entry of record[field.key] as unknown[]) eraseControls(entry, field.fields);
    else if (field.kind === 'actions' && Array.isArray(record[field.key]))
      for (const action of record[field.key] as { target: JsonObject }[]) {
        // URL targets remain free text; item targets are validated UUID references.
        delete action.target['kind'];
        delete action.target['itemId'];
      }
  }
}

/**
 * Inventory of unprojected free text: canonical URL; article tags and email list slug; block
 * credits, quote names/URLs, action URLs and video ids. Item slug is immutable on revision
 * writes. UUID references, dates, enums, block ids and booleans are structural controls.
 * Retain unknown strings by default, so a new text prop cannot become an unguarded store.
 */
function unprojectedText(doc: ContentDocument): Map<string, string> {
  const residual = structuredClone(doc);
  for (const field of localizedFields(doc)) erase(residual, field.path);
  delete residual.machineTranslation;
  if (residual.type === 'article')
    for (const correction of residual.corrections) erase(correction, ['date']);
  const root = residual as unknown as JsonObject;
  for (const key of ['type', 'defaultLocale', 'locales', 'access', 'authorIds', 'sectionId'])
    delete root[key];
  const strings = new Map<string, string>();
  const visit = (value: unknown, path: Path): void => {
    if (typeof value === 'string') strings.set(path.join('.'), value);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  for (const block of residual.blocks) {
    eraseControls(block.props, BLOCK_DEFINITIONS[block.type].fields);
    visit(block.props, ['blocks', block.id, 'props']);
  }
  delete root['blocks'];
  visit(root, []);
  return strings;
}

export function preserveTranslationReview(
  previous: ContentDocument,
  next: ContentDocument,
  approvedLocale?: string
): ContentDocument {
  const pending = new Set(
    Object.entries(previous.machineTranslation ?? {})
      .filter(([, paths]) => paths.length)
      .map(([locale]) => locale)
  );
  const refuse = (path: string): never => {
    throw new UseCaseError('invalid_input', 'approve pending translations before this change', [
      { path, message: 'content.publish.machine-translation-unreviewed' },
    ]);
  };
  if (pending.size) {
    for (const locale of pending) if (!next.locales.includes(locale)) refuse('document.locales');
    const before = unprojectedText(previous);
    const after = unprojectedText(next);
    for (const path of new Set([...before.keys(), ...after.keys()]))
      if (before.get(path) !== after.get(path)) refuse(`document.${path}`);
    for (const locale of next.locales)
      if (projection(previous, locale) !== projection(next, locale)) pending.add(locale);
  }
  for (const [locale, paths] of Object.entries(next.machineTranslation ?? {}))
    if (paths.length && next.locales.includes(locale)) pending.add(locale);
  // Only the internal approval handler passes this after actor, capability, lock and base checks.
  if (approvedLocale) pending.delete(approvedLocale);
  const document = { ...next };
  delete document.machineTranslation;
  if (pending.size)
    document.machineTranslation = Object.fromEntries(
      [...pending].map((locale) => [locale, ['locales']])
    );
  return document;
}
