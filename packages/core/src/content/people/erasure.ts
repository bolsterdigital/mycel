// The targeted scrub of ADR 034 rule 4, as pure functions over stored JSON: a credit whose
// `photographerPersonId` is a registered person id carries no free-text `photographer`. The same
// functions serve the repair (`apply`, over every stored copy) and the invariant at rest (every
// write that stores a credit), so the two cannot drift apart. Nothing else in a value changes:
// ids, structure and other text stay, so diff, provenance and undo keep working.
// Rejected: matching on the key `photographer` alone (a credit without a person id names nobody
// the register knows, ADR 034 rule 6) and a scrub per known schema path (a new block type with an
// image slot would be missed; a credit is recognised by its shape wherever it sits).

import type { TransactionContext } from '../../ports.js';
import type { Change } from '../diff.js';
import '../ports.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A person id as the register holds it: lower case. The input schema accepts any case and Postgres
 * compares `uuid` regardless of case, so a stored credit or `authorIds` entry may carry upper case;
 * every comparison with the register goes through this. Rejected: normalising only new input (rows
 * stored before still carry upper case and would escape the scrub).
 */
export const canonicalPersonId = (id: string): string => id.toLowerCase();

/** Whether `id` is in `erased`, a set of canonical ids as `registered()` returns them. */
const isErased = (erased: ReadonlySet<string>, id: unknown): boolean =>
  typeof id === 'string' && erased.has(canonicalPersonId(id));

/** Every `photographerPersonId` in a value, wherever a credit sits in it. */
export function creditPersonIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) creditPersonIds(v, into);
  else if (isObject(value)) {
    if (typeof value['photographerPersonId'] === 'string') into.add(value['photographerPersonId']);
    for (const v of Object.values(value)) creditPersonIds(v, into);
  }
  return into;
}

const scrubsHere = (o: Record<string, unknown>, erased: ReadonlySet<string>) =>
  isErased(erased, o['photographerPersonId']) && 'photographer' in o && o['photographer'] !== null;

/**
 * `value` with `photographer` set to null in every credit whose person id, in any case, is in
 * `erased` (canonical ids); the same reference when nothing changed, so a caller can tell a no-op
 * from a write.
 */
export function scrubErasedCredits<T>(value: T, erased: ReadonlySet<string>): T {
  if (!erased.size) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const s = scrubErasedCredits(v, erased);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? next : value) as T;
  }
  if (!isObject(value)) return value;
  let next: Record<string, unknown> | null = scrubsHere(value, erased)
    ? { ...value, photographer: null }
    : null;
  for (const [k, v] of Object.entries(value)) {
    const s = scrubErasedCredits(v, erased);
    if (s !== v) (next ??= { ...value })[k] = s;
  }
  return (next ?? value) as T;
}

/** The value at a diff path (`a.b[2][id=x]`) as `diffDocuments` writes it; undefined if absent. */
export function valueAtDiffPath(root: unknown, path: string): unknown {
  let at: unknown = root;
  for (const [, key, index, id] of path.matchAll(/\.?([^.[\]#]+)|\[(\d+)\]|\[id=([^\]]+)\]/g)) {
    if (key !== undefined) at = isObject(at) ? at[key] : undefined;
    else if (index !== undefined) at = Array.isArray(at) ? at[Number(index)] : undefined;
    else at = Array.isArray(at) ? at.find((x) => isObject(x) && x['id'] === id) : undefined;
    if (at === undefined) return undefined;
  }
  return at;
}

/**
 * A bulk plan's changes with the credit names of registered people nulled: object values are
 * scrubbed like any copy, and a change at a credit's `photographer` path is nulled when that
 * credit, in the plan's candidate or in a change of its person id beside it, names a registered
 * person (ADR 034 rule 4, "a plan change value at that credit's photographer path").
 */
export function scrubErasedChanges(
  changes: readonly Change[],
  candidate: unknown,
  erased: ReadonlySet<string>
): Change[] {
  if (!erased.size) return changes as Change[];
  let changed = false;
  const next = changes.map((c) => {
    let out: Change = c;
    const before = scrubErasedCredits(c.before, erased);
    const after = scrubErasedCredits(c.after, erased);
    if (before !== c.before || after !== c.after)
      out = { ...c, ...('before' in c ? { before } : {}), ...('after' in c ? { after } : {}) };
    if (c.path.endsWith('.photographer')) {
      const parent = c.path.slice(0, -'.photographer'.length);
      const credit = valueAtDiffPath(candidate, parent);
      const sibling = changes.find((x) => x.path === `${parent}.photographerPersonId`);
      const names = [
        isObject(credit) ? credit['photographerPersonId'] : undefined,
        sibling?.before,
        sibling?.after,
      ].some((id) => isErased(erased, id));
      if (names && ((out.before ?? null) !== null || (out.after ?? null) !== null))
        out = {
          ...out,
          ...('before' in c ? { before: null } : {}),
          ...('after' in c ? { after: null } : {}),
        };
    }
    if (out !== c) changed = true;
    return out;
  });
  return changed ? next : (changes as Change[]);
}

/**
 * The invariant at rest (ADR 034 rule 4) for one value a write is about to store: guarded against
 * a concurrent registration, every credit of a registered person loses its free-text name. A value
 * without a credit person id takes no lock.
 */
export async function withoutErasedCredits<T>(ctx: TransactionContext, value: T): Promise<T> {
  const ids = creditPersonIds(value);
  if (!ids.size) return value;
  await ctx.personErasures.guard();
  return scrubErasedCredits(value, await ctx.personErasures.registered(ids));
}

/**
 * ADR 034 rule 7: a person id passes a reference check when the person exists or is registered as
 * erased (a known-absent reference); an id in neither register is unknown.
 */
export async function knownPerson(ctx: TransactionContext, id: string): Promise<boolean> {
  const canonical = canonicalPersonId(id);
  if (await ctx.authors.get(canonical)) return true;
  return (await ctx.personErasures.registered([canonical])).has(canonical);
}

/** The person ids a plan preview's credits name: in the candidate, in change values and ids. */
export function planPersonIds(candidate: unknown, changes: readonly Change[]): Set<string> {
  const ids = creditPersonIds(changes, creditPersonIds(candidate));
  for (const c of changes)
    if (c.path.endsWith('.photographerPersonId'))
      for (const v of [c.before, c.after]) if (typeof v === 'string') ids.add(v);
  return ids;
}

/** A plan preview as it may be stored (ADR 034 rule 4): candidate and changes scrubbed. */
export async function withoutErasedPlanCredits<T>(
  ctx: TransactionContext,
  candidate: T,
  changes: readonly Change[]
): Promise<{ candidate: T; changes: Change[] }> {
  const ids = planPersonIds(candidate, changes);
  if (!ids.size) return { candidate, changes: changes as Change[] };
  await ctx.personErasures.guard();
  const erased = await ctx.personErasures.registered(ids);
  const scrubbed = scrubErasedCredits(candidate, erased);
  return { candidate: scrubbed, changes: scrubErasedChanges(changes, scrubbed, erased) };
}
