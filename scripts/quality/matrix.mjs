// Keep PR cost bounded and scheduled coverage explicit; no path filter can silently miss a
// new executable surface. Each cell starts on an isolated runner and database.
// The `demo` scope measures the seeded demo page and article, the content an editor sees first,
// in the scheduled/manual matrix only, with fresh cache: two more pages on every PR shard would
// push it past its ten-minute limit. Rejected: adding them to the default set.
import { readFileSync } from 'node:fs';

const corpus = JSON.parse(
  readFileSync(new URL('../../apps/web/e2e/quality-corpus.json', import.meta.url))
);

export function matrix(event, manifest = corpus, partition = true) {
  const full = ['schedule', 'workflow_dispatch'].includes(event);
  const include = [];
  for (const scope of full ? ['default', 'admin', 'demo'] : ['default'])
    for (const locale of full ? ['nl', 'en'] : ['nl'])
      for (const profile of ['mobile', 'desktop'])
        for (const cache of full && scope === 'default' ? ['fresh', 'warm', 'cold'] : ['fresh']) {
          const shard = { scope, locale, profile, cache };
          if (!full || !partition) include.push(shard);
          else {
            const names =
              scope === 'admin'
                ? manifest.admin.routes.map((entry) => entry.name)
                : publicNames(manifest, scope);
            // At most ten samples share the six-minute measurement budget. Keep the
            // sample count and deadline; a longer serial list hid missing tail cells.
            for (let i = 0; i < names.length; i += 2)
              include.push({
                ...shard,
                part: String(i / 2 + 1),
                routes: names.slice(i, i + 2).join(','),
              });
          }
        }
  return { include };
}

/** The public corpus entries a shard of this scope measures; `full` is the local everything. */
export function publicNames(manifest, scope) {
  return Object.entries(manifest.public)
    .filter(([, entry]) => scope === 'full' || (entry.set ?? 'default') === scope)
    .map(([name]) => name);
}
// The runner and evidence validator must select the same named routes; a typo cannot
// silently become an empty successful shard, or select a public page for an admin shard.
export function selectRoutes(entries, scope, route) {
  const eligible = entries.filter((entry) => scope !== 'admin' || !entry.indexable);
  if (!route) return eligible;
  const names = route.split(',');
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !eligible.some((entry) => entry.name === name))
  )
    throw new Error('Invalid route selection');
  return eligible.filter((entry) => names.includes(entry.name));
}
if (process.argv[1]?.endsWith('/matrix.mjs'))
  console.log(`value=${JSON.stringify(matrix(process.env.EVENT))}`);
