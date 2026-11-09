// Keep PR cost bounded and scheduled coverage explicit; no path filter can silently miss a
// new executable surface. Each cell starts on an isolated runner and database.
// The `demo` scope measures the seeded demo page and article, the content an editor sees first,
// in the scheduled/manual matrix only, with fresh cache: two more pages on every PR shard would
// push it past its ten-minute limit. Rejected: adding them to the default set.
export function matrix(event) {
  const full = ['schedule', 'workflow_dispatch'].includes(event);
  const include = [];
  for (const scope of full ? ['default', 'admin', 'demo'] : ['default'])
    for (const locale of full ? ['nl', 'en'] : ['nl'])
      for (const profile of ['mobile', 'desktop'])
        for (const cache of full && scope === 'default' ? ['fresh', 'warm', 'cold'] : ['fresh'])
          include.push({ scope, locale, profile, cache });
  return { include };
}

/** The public corpus entries a shard of this scope measures; `full` is the local everything. */
export function publicNames(manifest, scope) {
  return Object.entries(manifest.public)
    .filter(([, entry]) => scope === 'full' || (entry.set ?? 'default') === scope)
    .map(([name]) => name);
}
if (process.argv[1]?.endsWith('/matrix.mjs'))
  console.log(`value=${JSON.stringify(matrix(process.env.EVENT))}`);
