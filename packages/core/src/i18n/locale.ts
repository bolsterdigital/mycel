// Content localisation (ADR 007): every localisable field is `{ [locale]: value }` on the same
// document, built with `localized()`. Rejected: one document per locale with a `translation_of`
// link, which makes "is this page fully translated" a join and lets block structure drift.

import { z } from 'zod';

/** BCP 47 subset we accept: `nl`, `en`, `de`, `pt-BR`. */
export const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'i18n.locale.invalid');
export type Locale = z.infer<typeof Locale>;

export type Localized<T> = Partial<Record<string, T>>;

/** Languages written right to left, for a runtime whose `Intl.Locale` has no text info. */
const RIGHT_TO_LEFT = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/**
 * The writing direction of a locale, for `dir` next to every `lang` a page sets: from the
 * runtime's CLDR data (`Intl.Locale` text info), else from the language list above, else
 * left to right. Rejected: a direction setting per tenant locale, which a site owner would have
 * to know and could get wrong while the language already says it.
 */
export function textDirection(locale: string): 'ltr' | 'rtl' {
  let found: string | undefined;
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    found = (info.getTextInfo?.() ?? info.textInfo)?.direction;
  } catch {
    return 'ltr';
  }
  if (found === 'rtl' || found === 'ltr') return found;
  return RIGHT_TO_LEFT.has(locale.split('-')[0] ?? locale) ? 'rtl' : 'ltr';
}

/** Schema for a localisable field: a non-empty map from locale to value. */
export function localized<T extends z.ZodTypeAny>(schema: T): z.ZodRecord<typeof Locale, T> {
  return z
    .record(Locale, schema)
    .refine((value) => Object.keys(value).length > 0, 'i18n.localized.empty');
}

/** The value for `locale`, falling back to `fallback` (the document's default locale). */
export function pick<T>(value: Localized<T>, locale: string, fallback: string): T | undefined {
  return value[locale] ?? value[fallback];
}

/**
 * The value in the first of `locales` that has one, else in any locale at all: a screen that must
 * name a thing shows what there is. Rejected: a fallback written at each call site, which had
 * grown to eleven copies with different orders.
 */
export function pickAny<T>(value: Localized<T>, ...locales: string[]): T | undefined {
  for (const locale of locales) {
    const found = value[locale];
    if (found !== undefined && found !== null) return found;
  }
  return Object.values(value).find((found) => found !== undefined && found !== null);
}

/**
 * Picks the best of `available` for an `Accept-Language` header. Primary-tag match is enough for
 * now (`nl-BE` gets `nl`); quality values are honoured, everything else falls back.
 */
export function negotiateLocale(
  header: string | null | undefined,
  available: readonly string[],
  fallback: string
): string {
  if (!header) return fallback;
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((w) => w.tag && !Number.isNaN(w.q) && w.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const exact = available.find((a) => a.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const primary = tag.split('-')[0]?.toLowerCase();
    const loose = available.find((a) => a.split('-')[0]?.toLowerCase() === primary);
    if (loose) return loose;
  }
  return fallback;
}
