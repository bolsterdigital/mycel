// One pure selection rule for the served card and its enhancement. Rejected: selecting from
// the rest-view DOM, which can already have substituted another locale.
export function selectBlockName(names, candidates, locale, fallback, file = '') {
  const pick = (values) => [locale, fallback].map((l) => values?.[l]?.trim()).find(Boolean) || '';
  const automatic = candidates.map(pick).find(Boolean) || file;
  return { name: pick(names) || automatic, automatic };
}
