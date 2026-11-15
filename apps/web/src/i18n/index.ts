// Typed UI catalogs with per-key fallback to English, mirroring @mycel/core's `t`.
import { en, type UiKey } from './en.js';
import { nl } from './nl.js';

const catalogs: Record<string, Partial<Record<UiKey, string>>> = { en, nl };

export function ui(locale: string): (key: UiKey) => string {
  const primary = locale.split('-')[0] ?? locale;
  return (key) => catalogs[locale]?.[key] ?? catalogs[primary]?.[key] ?? en[key];
}
export type { UiKey };

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
