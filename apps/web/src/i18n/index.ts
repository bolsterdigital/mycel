// Typed UI catalogs with per-key fallback to English, mirroring @mycel/core's `t`.
import { en, type UiKey } from './en.js';
import { nl } from './nl.js';

const catalogs: Record<string, Partial<Record<UiKey, string>>> = { en, nl };

/** A catalog lookup that knows its language, so a counted phrase can pick its plural form. */
export type Ui = ((key: UiKey) => string) & { readonly lang: string };

export function ui(locale: string): Ui {
  const primary = locale.split('-')[0] ?? locale;
  const t = (key: UiKey) => catalogs[locale]?.[key] ?? catalogs[primary]?.[key] ?? en[key];
  return Object.assign(t, { lang: locale });
}
export type { UiKey };

/** The base of a counted phrase: a key with a `.one` and an `.other` form in the catalog. */
export type PluralKey = {
  [K in UiKey]: K extends `${infer B}.other` ? (`${B}.one` extends UiKey ? B : never) : never;
}[UiKey];

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * A counted phrase in the plural form the language needs for `n` (CLDR rules via
 * `Intl.PluralRules`): `{n}` is the count, or `vars.n` when the caller formatted it. A form the
 * catalog lacks (`few`, `many`, `two` in a language that has them) falls back to `.other`, so a
 * new catalog adds forms without touching a caller. Rejected: `n === 1 ? one : other` per page,
 * which is wrong for every language whose `one` is not exactly 1 (French 0, Russian 21) and
 * which every page wrote again.
 */
export function plural(
  t: Ui,
  key: PluralKey,
  n: number,
  vars: Record<string, string | number> = {}
): string {
  let rules = pluralRules.get(t.lang);
  if (!rules) pluralRules.set(t.lang, (rules = new Intl.PluralRules(t.lang)));
  const form = `${key}.${rules.select(n)}`;
  return fill(t(isUiKey(form) ? form : (`${key}.other` as const)), { n, ...vars });
}

/** Whether a key built at run time is in the catalog: a field-specific option label, say. */
export const isUiKey = (key: string): key is UiKey => key in en;

/** The UI language when nothing chose one. */
export const FALLBACK_LANG = 'en';

/** The UI language of this request. */
export const langOf = (locals: { lang?: string }): string => locals.lang ?? FALLBACK_LANG;

/**
 * A refusal a route handed its page (`failureOf`) in words. A limit names what it refused, so the
 * key has a `{what}` that is filled here and not by each page. The key crossed a form result, so
 * the type cannot prove it: this is the one cast for that. Rejected: a typed `form` per page
 * (SvelteKit widens the union of a page's actions, and half of them end in `unknown`).
 */
export function refusalCopy(
  t: (key: UiKey) => string,
  failed: { error?: unknown; what?: unknown },
  vars: Record<string, string | number> = {}
): string {
  const named = typeof failed.what === 'string' ? { what: t(failed.what as UiKey), ...vars } : vars;
  return fill(t(failed.error as UiKey), named);
}

/** Fills `{name}` placeholders: `fill(t('admin.signedInAs'), { email })`. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
