// A person id that a document, block or credit still holds while the person is gone (erased under
// ADR 034, so the id is an inert reference) must stay visible in the admin, or a native control
// would drop it silently on the next save and the editor would never see that someone was there.
// It is listed as its own option under a neutral label, checked or chosen as it was, so the editor
// can keep it or remove it like any other choice. Pickers never offer it anew: it only appears
// while it is selected. Rejected: hiding the id (the save would quietly rewrite attribution) and
// refusing the form (an erasure must never make someone else's document unsaveable, ADR 034
// rule 7).

/** `options` plus one entry per selected id that is not among them, first, in selection order. */
export function withAbsent<T extends { label: string }>(
  options: readonly T[],
  key: (option: T) => string,
  selected: readonly (string | null | undefined)[],
  absent: (id: string) => T
): T[] {
  const known = new Set(options.map(key));
  const missing = [...new Set(selected)].filter((id): id is string => !!id && !known.has(id));
  return [...missing.map(absent), ...options];
}

/** The short form of an id in a label: enough to tell two apart, short enough for 320 px. */
export const shortId = (id: string): string => id.slice(0, 8);
