// Canonical JSON for the audit input hash (brief #17b decision 3): object keys sorted, no
// whitespace, otherwise `JSON.stringify` semantics (undefined fields dropped, `toJSON` honoured).
// Two inputs that differ only in key order hash the same. Rejected: a library (RFC 8785/JCS),
// whose number formatting buys nothing for inputs that already passed a Zod schema.

export function canonicalJson(value: unknown): string {
  return canon(value) ?? 'null';
}

function canon(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object' && 'toJSON' in value) {
    const toJSON = (value as { toJSON: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canon(v) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value)
      .sort()
      .flatMap((k) => {
        const v = canon((value as Record<string, unknown>)[k]);
        return v === undefined ? [] : [`${JSON.stringify(k)}:${v}`];
      });
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}
