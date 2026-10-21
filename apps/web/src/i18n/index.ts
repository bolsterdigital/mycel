// Typed UI catalogs with per-key fallback to English, mirroring @mycel/core's `t`.
import { en, type UiKey } from './en.js';
import { nl } from './nl.js';

const catalogs: Record<string, Partial<Record<UiKey, string>>> = { en, nl };

export function ui(locale: string): (key: UiKey) => string {
  const primary = locale.split('-')[0] ?? locale;
  return (key) => catalogs[locale]?.[key] ?? catalogs[primary]?.[key] ?? en[key];
}
export type { UiKey };
