// Typed UI catalogs with per-key fallback to English, mirroring @mycel/core's `t`.
import { en, type UiKey } from './en.js';
import { nl } from './nl.js';

const catalogs: Record<string, Partial<Record<UiKey, string>>> = { en, nl };

export function ui(locale: string): (key: UiKey) => string {
  const primary = locale.split('-')[0] ?? locale;
  return (key) => catalogs[locale]?.[key] ?? catalogs[primary]?.[key] ?? en[key];
}
export type { UiKey };

/** The UI language when nothing chose one. */
export const FALLBACK_LANG = 'en';

/** The UI language of this request. */
export const langOf = (locals: { lang?: string }): string => locals.lang ?? FALLBACK_LANG;

/** Fills `{name}` placeholders: `fill(t('admin.signedInAs'), { email })`. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
