// Typed message catalogs for domain copy (ADR 007): validation messages and e-mail boilerplate.
// Rejected: i18next/Paraglide; typed objects plus `Intl` cover the need with zero dependencies.

import { en, type MessageKey, type Messages } from './en.js';
import { nl } from './nl.js';

export { en, nl };
export type { MessageKey, Messages };
export * from './locale.js';

const catalogs: Record<string, Partial<Messages>> = { en, nl };

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** Translate `key` into `locale`, falling back to English, interpolating `{name}` params. */
export function t(locale: string, key: MessageKey, params: Record<string, string> = {}): string {
  const primary = locale.split('-')[0] ?? locale;
  const template = catalogs[locale]?.[key] ?? catalogs[primary]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/** Like `t`, but for keys that arrive as data (Zod issue messages); unknown keys pass through. */
export function translate(locale: string, key: string, params?: Record<string, string>): string {
  return isMessageKey(key) ? t(locale, key, params) : key;
}
