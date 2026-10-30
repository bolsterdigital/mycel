// The document fields of the content admin (TODO #11, brief content-editor § A1) as plain form
// values and back. The edit page posts these fields only; `documentFrom` takes the revision the
// form was opened on and replaces exactly those fields, so the blocks travel along unchanged and
// a save never drops what the form does not show (ADR 020 rule 5). Both directions are pure, so a
// round trip is a unit test, and a failed post re-renders from the posted values without a read.
//
// A field left empty in a locale removes that locale's key: an empty string is not a translation.
// Taking a locale off the document removes its values everywhere in the document, blocks
// included; the revision history keeps them. Rejected: refusing to remove a locale that still has
// text (until #11 B there is no way to clear a block's text in the admin), and keeping the values
// (core rejects a value for a locale the document does not have).
//
// Authors and the section are picked from a bounded page of the site's directory, which need not
// hold what the document already has. So the edit page lists the document's
// own authors first, in its order, resolved one by one, and its section even when the page lacks
// it (`withAssigned`); and `documentFrom` keeps the order of the authors that stay, adding new
// ones after them. A save that only changes the title then keeps both. Rejected: a hidden field
// with the ids the form did not show (a second source of truth that a stale form gets wrong too),
// and loading the whole directory (unbounded).

import {
  canonicalTag,
  localizedFields,
  type Actor,
  type ContentDocument,
  type ContentDocumentInput,
} from '@mycel/core';
import { localInput } from './content-admin-publication.js';

/** Form values: one string per field, a list for checkboxes and multi-selects. */
export type FormValues = Record<string, string | string[]>;

/** The values a form post carries, in the shape `valuesOf` gives. */
export function valuesFromForm(data: FormData): FormValues {
  const out: FormValues = {};
  for (const key of new Set(data.keys())) {
    const all = data.getAll(key).filter((v): v is string => typeof v === 'string');
    out[key] = LISTS.has(key) ? all : (all[0] ?? '');
  }
  for (const key of LISTS) out[key] ??= [];
  return out;
}

const LISTS = new Set(['locales', 'authorIds']);

const one = (v: FormValues, key: string): string => {
  const x = v[key];
  return typeof x === 'string' ? x : '';
};
const many = (v: FormValues, key: string): string[] => {
  const x = v[key];
  return Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : [];
};

/** `{ nl: 'x' }` from `title.nl` and friends; empty values are left out. */
function localized(v: FormValues, prefix: string, locales: readonly string[]) {
  const out: Record<string, string> = {};
  for (const l of locales) {
    const text = one(v, `${prefix}.${l}`).trim();
    if (text) out[l] = text;
  }
  return out;
}
const optional = (m: Record<string, string>) => (Object.keys(m).length ? m : undefined);

/**
 * A media picker's value: the posted id, '' for "no image", and the document's own value when
 * the form has no such field at all (a form that does not show the picker keeps the image).
 */
const image = (v: FormValues, key: string, kept: string | undefined): string | undefined =>
  key in v ? one(v, key) || undefined : kept;

/** The form values of a document's fields, for a fresh edit page. */
export function valuesOf(doc: ContentDocument): FormValues {
  const v: FormValues = { locales: [...doc.locales] };
  const put = (prefix: string, m: Partial<Record<string, string>> | undefined) => {
    for (const [l, text] of Object.entries(m ?? {}))
      if (text !== undefined) v[`${prefix}.${l}`] = text;
  };
  put('title', doc.title);
  put('seoTitle', doc.seo.title);
  put('seoDescription', doc.seo.description);
  if (doc.seo.noindex) v.noindex = 'on';
  v.canonical = doc.seo.canonical ?? '';
  v.featuredImageId = doc.featuredImageId ?? '';
  v.shareImageId = doc.seo.imageId ?? '';
  v.level = doc.access.level;
  const teaser = doc.access.teaser;
  v.teaser = typeof teaser === 'object' ? 'blocks' : teaser;
  v.teaserBlocks = typeof teaser === 'object' ? String(teaser.blocks) : '';
  if (doc.type === 'article') {
    put('lead', doc.lead);
    v.authorIds = [...doc.authorIds];
    v.sectionId = doc.sectionId ?? '';
    v.tags = doc.tags.join(', ');
  }
  return v;
}

/**
 * `base` with the form's fields put in; the result goes to `content.item.update`, which
 * validates it. `today` dates a new correction when the form gives no date.
 */
export function documentFrom(
  base: ContentDocument,
  v: FormValues,
  today: string
): ContentDocumentInput {
  const chosen = many(v, 'locales');
  const locales = chosen.length ? chosen : [...base.locales];
  const doc = withoutLocales(base, locales);
  const teaser = one(v, 'teaser');
  const level = one(v, 'level') as ContentDocument['access']['level'];
  const seo: ContentDocumentInput['seo'] = { noindex: one(v, 'noindex') === 'on' };
  const seoTitle = optional(localized(v, 'seoTitle', locales));
  const seoDescription = optional(localized(v, 'seoDescription', locales));
  const canonical = one(v, 'canonical').trim();
  if (seoTitle) seo.title = seoTitle;
  if (seoDescription) seo.description = seoDescription;
  if (canonical) seo.canonical = canonical;
  const shareImage = image(v, 'shareImageId', doc.seo.imageId);
  if (shareImage) seo.imageId = shareImage;
  const featuredImageId = image(v, 'featuredImageId', doc.featuredImageId);
  const tierIds = (level || doc.access.level) === 'tier' ? doc.access.tierIds : undefined;
  const { featuredImageId: _featured, ...rest } = doc;
  const common = {
    ...rest,
    ...(featuredImageId ? { featuredImageId } : {}),
    locales,
    title: localized(v, 'title', locales),
    seo,
    // The access fields show only on a site with readers (#66 PR 2); a form without them keeps
    // the document's access as it is.
    access:
      'level' in v
        ? {
            level: level || doc.access.level,
            ...(tierIds ? { tierIds } : {}),
            teaser:
              teaser === 'blocks'
                ? { blocks: Number.parseInt(one(v, 'teaserBlocks'), 10) || 0 }
                : teaser === 'marker'
                  ? ('marker' as const)
                  : ('lead' as const),
          }
        : doc.access,
  };
  if (doc.type !== 'article') return common as ContentDocumentInput;

  const correction = localized(v, 'correctionText', locales);
  return {
    ...common,
    type: 'article',
    lead: optional(localized(v, 'lead', locales)),
    authorIds: keepOrder(doc.authorIds, many(v, 'authorIds')),
    sectionId: one(v, 'sectionId') || null,
    tags: one(v, 'tags')
      .split(',')
      .map(canonicalTag)
      .filter((t) => t),
    corrections: Object.keys(correction).length
      ? [...doc.corrections, { date: one(v, 'correctionDate') || today, text: correction }]
      : doc.corrections,
  } as ContentDocumentInput;
}

/** The posted ids with those of `before` first, in `before`'s order; new ones follow as posted. */
export function keepOrder(before: readonly string[], posted: readonly string[]): string[] {
  const chosen = new Set(posted);
  const kept = before.filter((id) => chosen.has(id));
  return [...new Set([...kept, ...posted])];
}

/**
 * The choices of a picker: the document's own entries first and in its order, each from `page`
 * when the page has it or from `resolve` otherwise (`null` for one that no longer exists, shown
 * by its id so a save keeps it), then the rest of `page`.
 */
export async function withAssigned<T extends { id: string }>(
  assigned: readonly string[],
  page: readonly T[],
  resolve: (id: string) => Promise<T | null>,
  missing: (id: string) => T
): Promise<T[]> {
  const byId = new Map(page.map((x) => [x.id, x]));
  const own = await Promise.all(
    assigned.map(async (id) => byId.get(id) ?? (await resolve(id)) ?? missing(id))
  );
  const mine = new Set(assigned);
  return [...own, ...page.filter((x) => !mine.has(x.id))];
}

/** A copy of `doc` without any value for a locale outside `keep` (see the top of this file). */
export function withoutLocales(doc: ContentDocument, keep: readonly string[]): ContentDocument {
  const copy = structuredClone(doc);
  // `localizedFields` hands out the maps of `copy` itself, so deleting from them edits the copy.
  for (const field of localizedFields(copy))
    for (const l of Object.keys(field.value)) if (!keep.includes(l)) delete field.value[l];
  return copy;
}

/** Who saved a revision, in a few words. */
export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'operator':
      return actor.email;
    case 'api-key':
      return `API key ${actor.keyId.slice(0, 8)}`;
    case 'agent':
      return `MCP ${actor.keyId.slice(0, 8)}`;
    case 'system':
      return actor.job;
    default:
      return actor.kind;
  }
}

/** `2026-10-23 16:05`, the admin's one timestamp form, in the admin's zone (`adminTimeZone`). */
export const when = (iso: string, zone: string): string =>
  localInput(new Date(iso), zone).replace('T', ' ');

/** The rows of a diff table: short JSON per value, never a whole document. */
export function diffRows(
  changes: readonly { path: string; before?: unknown; after?: unknown }[]
): { path: string; before: string; after: string }[] {
  const show = (v: unknown): string => {
    if (v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
  };
  return changes.map((c) => ({ path: c.path, before: show(c.before), after: show(c.after) }));
}
