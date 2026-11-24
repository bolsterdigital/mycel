// Mark localized prose and links without invalidating a block before projection. Keeping the
// origin and path of a link lets the same sentinel prove the schema and renderer do not leak it.
export const LOCALE_SENTINEL = 'LEAK-SENTINEL';

export function markEnglish(value: unknown, inEnglish = false, key = ''): unknown {
  if (typeof value === 'string') {
    if (!inEnglish || (key !== 'en' && key !== 'text')) return value;
    if (key === 'en' && value.startsWith('https://')) {
      const url = new URL(value);
      url.searchParams.set('fixture', LOCALE_SENTINEL);
      return url.href;
    }
    return LOCALE_SENTINEL;
  }
  if (Array.isArray(value)) return value.map((entry) => markEnglish(entry, inEnglish));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        markEnglish(entry, inEnglish || key === 'en', key),
      ])
    );
  return value;
}
