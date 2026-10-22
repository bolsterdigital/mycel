// The difference between two revisions as data (ADR 009 rule 9): a deterministic list of changed
// JSON paths with the value before and after. Blocks are matched by id, not by position, so a
// moved block shows as one order change instead of every later block "changing" (ADR 020 rule
// 1). Rejected: a diff library (a dependency for 60 lines, ADR 008 policy 1) and HTML output
// (the renderer is an adapter; fronts present the paths their own way).

export interface Change {
  path: string;
  before?: unknown;
  after?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasIds = (v: unknown[]): v is { id: string }[] =>
  v.every((x) => isObject(x) && typeof x['id'] === 'string');

const key = (path: string, k: string) => (path ? `${path}.${k}` : k);

export function diffDocuments(before: unknown, after: unknown): Change[] {
  const changes: Change[] = [];
  compare(before, after, '', changes);
  return changes;
}

function compare(a: unknown, b: unknown, path: string, out: Change[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a === undefined) return void out.push({ path, after: b });
  if (b === undefined) return void out.push({ path, before: a });
  if (isObject(a) && isObject(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      compare(a[k], b[k], key(path, k), out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && hasIds(a) && hasIds(b)) {
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    const shared = ids(a).filter((id) => ids(b).includes(id));
    const order = (xs: { id: string }[]) => ids(xs).filter((id) => shared.includes(id));
    if (JSON.stringify(order(a)) !== JSON.stringify(order(b)))
      out.push({ path: `${path}#order`, before: ids(a), after: ids(b) });
    const byId = (xs: { id: string }[]) => new Map(xs.map((x) => [x.id, x]));
    const [ma, mb] = [byId(a), byId(b)];
    // Removed blocks in old order, then kept and added ones in new order.
    for (const x of a) if (!mb.has(x.id)) out.push({ path: `${path}[id=${x.id}]`, before: x });
    for (const x of b) compare(ma.get(x.id), x, `${path}[id=${x.id}]`, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      compare(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  out.push({ path, before: a, after: b });
}
