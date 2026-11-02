// The document fields of the content admin (TODO #11, brief content-editor § A1) as plain form
// values and back. The edit page posts these fields only; `documentFrom` takes the revision the
// form was opened on and replaces exactly those fields, so the blocks travel along unchanged and
// a save never drops what the form does not show (ADR 020 rule 5). Both directions are pure, so a
// round trip is a unit test, and a failed post re-renders from the posted values without a read.
//
// A field left empty in a locale removes that locale's key: an empty string is not a translation.
// Taking a locale off the document removes its values everywhere in the document, blocks
// included; the revision history keeps them.
//
// The edit screen shows one locale at a time (#66 PR 4, ADR 020 rule 5): `documentFrom` with an
// `editing` locale reads only that locale's values from the form and keeps every other locale of
// every localised field exactly as the base revision has it. That is the merge which makes a
// form of one locale safe; content-admin.test.ts proves it as a property. Rejected: posting the
// other locales as hidden fields (a stale tab would write them back over a newer translation). Rejected: refusing to remove a locale that still has
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

/**
 * `{ nl: 'x' }` from `title.nl` and friends; empty values are left out. With `editing`, only that
 * locale comes from the form and every other locale of `locales` keeps what `kept` has.
 */
function localized(
  v: FormValues,
  prefix: string,
  locales: readonly string[],
  editing?: { locale: string | null; kept: Partial<Record<string, string>> | undefined }
) {
  const out: Record<string, string> = {};
  for (const l of locales) {
    if (editing && l !== editing.locale) {
      const kept = editing.kept?.[l];
      if (kept !== undefined) out[l] = kept;
      continue;
    }
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
  put('lead', doc.lead);
  v.heroImageId = doc.heroImageId ?? '';
  // Without an alt the hero is decorative (#99); the box is ticked, as for a new image.
  if (!doc.heroAlt) v.heroDecorative = 'on';
  put('heroAlt', doc.heroAlt);
  v.featuredImageId = doc.featuredImageId ?? '';
  put('featuredTitle', doc.featured?.title);
  put('featuredDescription', doc.featured?.description);
  v.shareImageId = doc.seo.imageId ?? '';
  v.level = doc.access.level;
  const teaser = doc.access.teaser;
  v.teaser = typeof teaser === 'object' ? 'blocks' : teaser;
  v.teaserBlocks = typeof teaser === 'object' ? String(teaser.blocks) : '';
  if (doc.type === 'article') {
    v.headerLayout = doc.presentation?.header ?? 'standard';
    v.authorIds = [...doc.authorIds];
    v.sectionId = doc.sectionId ?? '';
    v.tags = doc.tags.join(', ');
  }
  return v;
}

/**
 * `base` with the form's fields put in; the result goes to `content.item.update`, which
 * validates it. `today` dates a new correction when the form gives no date. `editing` is the one
 * locale the form shows (#66 PR 4): every other locale keeps the base's values; `null` reads no
 * locale at all (a form opened on a locale the document does not have yet); left out, the form
 * carries every locale of the document.
 */
export function documentFrom(
  base: ContentDocument,
  v: FormValues,
  today: string,
  editing?: string | null
): ContentDocumentInput {
  const chosen = many(v, 'locales');
  const locales = chosen.length ? chosen : [...base.locales];
  const doc = withoutLocales(base, locales);
  // The locale the form shows, if the document (still) has it; a locale taken off is not read.
  const shown =
    editing === undefined ? undefined : editing && locales.includes(editing) ? editing : null;
  /** The localised map under `prefix`, merged with `kept` when the form shows one locale. */
  const pick = (prefix: string, kept: Partial<Record<string, string>> | undefined) =>
    localized(v, prefix, locales, shown === undefined ? undefined : { locale: shown, kept });
  const teaser = one(v, 'teaser');
  const level = one(v, 'level') as ContentDocument['access']['level'];
  const seo: ContentDocumentInput['seo'] = { noindex: one(v, 'noindex') === 'on' };
  const seoTitle = optional(pick('seoTitle', doc.seo.title));
  const seoDescription = optional(pick('seoDescription', doc.seo.description));
  const canonical = one(v, 'canonical').trim();
  if (seoTitle) seo.title = seoTitle;
  if (seoDescription) seo.description = seoDescription;
  if (canonical) seo.canonical = canonical;
  const shareImage = image(v, 'shareImageId', doc.seo.imageId);
  if (shareImage) seo.imageId = shareImage;
  const heroImageId = image(v, 'heroImageId', doc.heroImageId);
  // The alt belongs to the hero (#99): read where the form showed it (`heroAltShown`, the box only
  // shows once there is an image), kept otherwise, gone with the image. An unticked box with no
  // text in any locale is sent as `{}`, which core refuses. A different image keeps no stored
  // description (it described the old picture, in every locale): only text typed over it counts,
  // and without that the new image is decorative until someone describes it (MY-110 B3).
  const replaced = !!heroImageId && heroImageId !== doc.heroImageId;
  const retyped = (alt: Partial<Record<string, string>>) => {
    const typed = Object.entries(alt).filter(([l, text]) => text && text !== doc.heroAlt?.[l]);
    return typed.length ? Object.fromEntries(typed) : undefined;
  };
  const heroAlt = !heroImageId
    ? undefined
    : 'heroAltShown' in v
      ? one(v, 'heroDecorative') === 'on'
        ? undefined
        : replaced
          ? retyped(pick('heroAlt', undefined))
          : pick('heroAlt', doc.heroAlt)
      : replaced
        ? undefined
        : doc.heroAlt;
  const featuredImageId = image(v, 'featuredImageId', doc.featuredImageId);
  const featured = {
    title: optional(pick('featuredTitle', doc.featured?.title)),
    description: optional(pick('featuredDescription', doc.featured?.description)),
  };
  const tierIds = (level || doc.access.level) === 'tier' ? doc.access.tierIds : undefined;
  const {
    heroImageId: _hero,
    heroAlt: _heroAlt,
    featuredImageId: _featured,
    featured: _featuredTexts,
    lead: _lead,
    ...rest
  } = doc;
  const lead = optional(pick('lead', doc.lead));
  const common = {
    ...rest,
    ...(heroImageId ? { heroImageId } : {}),
    ...(heroAlt ? { heroAlt } : {}),
    ...(featuredImageId ? { featuredImageId } : {}),
    // Absent rather than `{}` when both are empty: a stored document parses byte for byte.
    ...(featured.title || featured.description
      ? {
          featured: {
            ...(featured.title ? { title: featured.title } : {}),
            ...(featured.description ? { description: featured.description } : {}),
          },
        }
      : {}),
    ...(lead ? { lead } : {}),
    locales,
    title: pick('title', doc.title),
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

  // A new correction is written in the locale the form shows; the stored ones stay as they are.
  const correction = localized(
    v,
    'correctionText',
    shown === undefined ? locales : shown ? [shown] : []
  );
  // A form without the choice keeps it; the default is stored as absent, as on an older revision.
  const { presentation: _presentation, ...article } = common as typeof common & {
    presentation?: { header?: 'standard' | 'cover' };
  };
  const header = 'headerLayout' in v ? one(v, 'headerLayout') : doc.presentation?.header;
  return {
    ...article,
    ...(header === 'cover' ? { presentation: { header } } : {}),
    type: 'article',
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

/**
 * A copy of `doc` with `to` among its locales: empty, or with every localised value of `from`
 * copied (#66 PR 4, "start the translation from nl"). Nothing else changes, so the copy is an
 * ordinary save; readiness then holds the new locale to the same fields as the others.
 */
export function withLocale(doc: ContentDocument, to: string, from: string | null): ContentDocument {
  const copy = structuredClone(doc);
  if (!copy.locales.includes(to)) copy.locales = [...copy.locales, to];
  if (from && from !== to && doc.locales.includes(from))
    for (const field of localizedFields(copy))
      if (field.value[from] !== undefined && field.value[to] === undefined)
        field.value[to] = structuredClone(field.value[from]);
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
