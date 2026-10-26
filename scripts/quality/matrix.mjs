// Keep PR cost bounded and scheduled coverage explicit; no path filter can silently miss a
// new executable surface. Each cell starts on an isolated runner and database.
export function matrix(event) {
  const full = ['schedule', 'workflow_dispatch'].includes(event);
  const include = [];
  for (const scope of full ? ['default', 'admin'] : ['default'])
    for (const locale of full ? ['nl', 'en'] : ['nl'])
      for (const profile of ['mobile', 'desktop'])
        for (const cache of full && scope === 'default' ? ['fresh', 'warm', 'cold'] : ['fresh'])
          include.push({ scope, locale, profile, cache });
  return { include };
}
if (process.argv[1]?.endsWith('/matrix.mjs'))
  console.log(`value=${JSON.stringify(matrix(process.env.EVENT))}`);
