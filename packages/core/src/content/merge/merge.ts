// Three-way merge of two saves on one base (ADR 026): what the caller changed since the revision
// it read, and what was saved since, are combined per document field, per locale of a localised
// map and per block by id; only a value both sides changed differently is a conflict. Rules:
//
// - Objects merge key by key, so `title.nl` and `title.en` are separate values, as are two props
//   of one block. A ProseMirror document (`type: 'doc'`) is one value: text inside one rich-text
//   block does not merge (ADR 026 rule 3).
// - A list whose items carry an `id` (the block tree, at every depth) merges per id: an item one
//   side removed and the other left alone is removed; removed by one and changed by the other is
//   a conflict. Order is one value of the list: both reordering differently is a conflict;
//   additions follow their predecessor on the side that added them. Any other list (authors,
//   tags, corrections, locales) is one value.
// - The result is the merge with the caller's value at every conflict: the proposal a front
//   shows, never something core stores while a conflict is open.
//
// Paths use the grammar of `diff.ts` (`blocks[id=x].props.text.nl`, `blocks#order`), so a front
// labels a conflict with the same code that labels a difference. Rejected: a JSON-patch or CRDT
// library (a dependency for a hundred lines, ADR 008 policy 1, and a CRDT needs every keystroke,
// which realtime would bring and A6 declined), and merging inside rich text, which needs a
// paragraph identity the schema does not have.

import { canonicalJson } from '../../util/canonical-json.js';

export interface MergeConflict {
  path: string;
  base?: unknown;
  mine?: unknown;
  theirs?: unknown;
}

export interface MergeResult<T> {
  /** The merge, with the caller's value wherever `conflicts` names a path. */
  document: T;
  conflicts: MergeConflict[];
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Equal as JSON (key order and absent keys aside); `undefined` is only equal to itself. */
const same = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);

/** One value however deep: a rich-text document. */
const atomic = (v: Obj): boolean => v['type'] === 'doc';

const idOf = (v: unknown): string | undefined =>
  isObject(v) && typeof v['id'] === 'string' ? v['id'] : undefined;

/** A list merged per id: base and theirs all carry ids; the caller's new items may not yet. */
const keyed = (base: unknown[], mine: unknown[], theirs: unknown[]): boolean =>
  base.length + theirs.length > 0 &&
  [...base, ...theirs].every((x) => idOf(x) !== undefined) &&
  mine.every(isObject);

const key = (path: string, k: string) => (path ? `${path}.${k}` : k);
const item = (path: string, id: string) => `${path}[id=${id}]`;

export function mergeDocuments<T>(base: T, mine: T, theirs: T): MergeResult<T> {
  const conflicts: MergeConflict[] = [];
  const document = merge(base, mine, theirs, '', conflicts) as T;
  return { document, conflicts };
}

function merge(base: unknown, mine: unknown, theirs: unknown, path: string, out: MergeConflict[]) {
  if (same(mine, theirs)) return mine;
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (isObject(base) && isObject(mine) && isObject(theirs) && !atomic(base) && !atomic(mine)) {
    const result: Obj = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const v = merge(base[k], mine[k], theirs[k], key(path, k), out);
      if (v !== undefined) result[k] = v;
    }
    return result;
  }
  if (
    Array.isArray(base) &&
    Array.isArray(mine) &&
    Array.isArray(theirs) &&
    keyed(base, mine, theirs)
  )
    return mergeList(base, mine, theirs, path, out);
  out.push({ path, base, mine, theirs });
  return mine;
}

function mergeList(
  base: unknown[],
  mine: unknown[],
  theirs: unknown[],
  path: string,
  out: MergeConflict[]
): unknown[] {
  // The caller's items without an id are new: a key of their own that no other side has.
  const keys = (xs: unknown[], side: string) => xs.map((x, i) => idOf(x) ?? `\0${side}${i}`);
  const [kb, km, kt] = [keys(base, 'b'), keys(mine, 'm'), keys(theirs, 't')];
  const map = (ks: string[], xs: unknown[]) => new Map(ks.map((k, i) => [k, xs[i]]));
  const [B, M, T] = [map(kb, base), map(km, mine), map(kt, theirs)];
  const kept = new Map<string, unknown>();
  for (const k of new Set([...kb, ...km, ...kt])) {
    const [b, m, t] = [B.get(k), M.get(k), T.get(k)];
    const at = item(path, k.startsWith('\0') ? '' : k);
    if (b !== undefined && m === undefined && t === undefined) continue;
    if (b !== undefined && m === undefined) {
      // Removed here, changed there: a choice; the proposal keeps the removal.
      if (!same(t, b)) out.push({ path: at, base: b, theirs: t });
      continue;
    }
    if (b !== undefined && t === undefined) {
      if (same(m, b)) continue;
      out.push({ path: at, base: b, mine: m });
      kept.set(k, m);
      continue;
    }
    kept.set(k, merge(b, m, t, at, out));
  }
  // Order of what all three sides still have, as one value of the list.
  const common = kb.filter((k) => M.has(k) && T.has(k));
  const order = (ks: string[]) => ks.filter((k) => common.includes(k));
  const [ob, om, ot] = [order(kb), order(km), order(kt)];
  let seq: string[];
  if (same(om, ot) || same(ot, ob)) seq = om;
  else if (same(om, ob)) seq = ot;
  else {
    out.push({ path: `${path}#order`, base: ob, mine: om, theirs: ot });
    seq = om;
  }
  // Everything else follows its predecessor on the side that has it: the caller's first.
  for (const ks of [km, kt]) {
    let prev: string | null = null;
    for (const k of ks) {
      if (!kept.has(k)) continue;
      if (!seq.includes(k)) seq.splice(prev === null ? 0 : seq.indexOf(prev) + 1, 0, k);
      prev = k;
    }
  }
  return seq.map((k) => kept.get(k));
}

// Paths, for a front that resolves a conflict one value at a time.

type Step = { key: string } | { id: string } | { order: true };

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const STEP = /\.?([^.[#]+)|\[id=([^\]]*)\]|#order/g;

function steps(path: string): Step[] {
  const out: Step[] = [];
  for (const m of path.matchAll(STEP))
    out.push(
      m[1] !== undefined ? { key: m[1] } : m[2] !== undefined ? { id: m[2] } : { order: true }
    );
  return out;
}

function child(node: unknown, step: Step): unknown {
  if ('key' in step) return isObject(node) ? node[step.key] : undefined;
  if ('id' in step) return Array.isArray(node) ? node.find((x) => idOf(x) === step.id) : undefined;
  return Array.isArray(node) ? node.map(idOf) : undefined;
}

/** The value at a merge path, or undefined when the path leads nowhere. */
export function valueAt(doc: unknown, path: string): unknown {
  return steps(path).reduce<unknown>((node, s) => child(node, s), doc);
}

/**
 * `doc` with the value `source` has at `path`: set, removed when `source` has none, an item put
 * back after its nearest predecessor in `source` that `doc` still has, a list put in `source`'s
 * order. A path that leads nowhere in `doc` changes nothing. `doc` is not modified.
 */
export function takeValue<T>(doc: T, source: unknown, path: string): T {
  const all = steps(path);
  const copy = structuredClone(doc);
  // A path is input (a posted choice): it never reaches an object's prototype.
  if (all.some((s) => 'key' in s && UNSAFE.has(s.key))) return copy;
  let node: unknown = copy;
  let from: unknown = source;
  for (const s of all.slice(0, -1)) {
    node = child(node, s);
    from = child(from, s);
    if (node === undefined) return copy;
  }
  const last = all.at(-1);
  if (!last) return structuredClone(source as T);
  if ('key' in last) {
    if (!isObject(node)) return copy;
    const v = isObject(from) ? from[last.key] : undefined;
    if (v === undefined) delete node[last.key];
    else node[last.key] = structuredClone(v);
    return copy;
  }
  if (!Array.isArray(node)) return copy;
  const list = Array.isArray(from) ? from : [];
  if ('order' in last) {
    const ids = list.map(idOf);
    const shared = node.filter((x) => ids.includes(idOf(x)));
    shared.sort((a, b) => ids.indexOf(idOf(a)) - ids.indexOf(idOf(b)));
    let i = 0;
    node.forEach((x, j) => {
      if (ids.includes(idOf(x))) node[j] = shared[i++];
    });
    return copy;
  }
  const at = node.findIndex((x) => idOf(x) === last.id);
  const wanted = list.findIndex((x) => idOf(x) === last.id);
  if (wanted < 0) {
    if (at >= 0) node.splice(at, 1);
    return copy;
  }
  const value = structuredClone(list[wanted]);
  if (at >= 0) {
    node[at] = value;
    return copy;
  }
  const before = list
    .slice(0, wanted)
    .map(idOf)
    .reverse()
    .find((id) => node.some((x) => idOf(x) === id));
  node.splice(before === undefined ? 0 : node.findIndex((x) => idOf(x) === before) + 1, 0, value);
  return copy;
}
