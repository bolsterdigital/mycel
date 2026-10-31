// The words for an audit row (brief admin-operations-screens § 5): the log stores the use-case
// name, the actor kind and id and a result code; the administrator reads "Item published" by a
// member's name, "Refused: no permission". Every command of the registry has its words in the
// catalogue (audit-words.test.ts), so the technical name only shows for an operation the
// catalogue cannot know, such as a platform action or one from a newer release. Pure and
// client-safe, like issue-label.ts; rejected: words per use case in core (copy belongs in the
// web catalogue, ADR 007) and a lookup in the server load (the status page and the log would
// each carry the same mapping).

import { en, type UiKey } from '../../i18n/en.js';

const has = (key: string): key is UiKey => key in en;

/** The operation in words, or null when the catalogue has none and the name is all there is. */
export function operationKey(operation: string): UiKey | null {
  const key = `admin.audit.op.${operation}`;
  return has(key) ? key : null;
}

/** `ok`, a known refusal, or `error` for anything else. */
export function resultKey(result: string): UiKey {
  const key = `admin.audit.result.${result}`;
  return has(key) ? key : 'admin.audit.result.error';
}

export const actorKindKey = (kind: string): UiKey => {
  const key = `admin.audit.actor.${kind}`;
  return has(key) ? key : 'admin.audit.actor.unknown';
};

/** Who did it, from the names the page knows; a kind in words when the id has no name. */
export function actorLabel(
  t: (key: UiKey) => string,
  row: { actorKind: string; actorId: string | null },
  names: Readonly<Record<string, string>>
): string {
  const name = row.actorId ? names[`${row.actorKind}:${row.actorId}`] : undefined;
  return name ?? t(actorKindKey(row.actorKind));
}
