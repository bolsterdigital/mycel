// Baselines are diagnostics, never substitute targets. Reuse only a successful summary with
// identical corpus/tool/runner settings; an absent or incompatible predecessor is explicit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function compareBaseline(current, previous) {
  if (!previous || previous.state !== 'pass')
    return { state: 'no baseline', reason: 'no successful predecessor' };
  if (
    previous.fixtureHash !== current.fixtureHash ||
    JSON.stringify(previous.environment) !== JSON.stringify(current.environment)
  )
    return { state: 'no baseline', reason: 'corpus/tool/runner profile changed' };
  return {
    state: 'compared',
    commit: previous.commit,
    cells: current.cells.map((cell) => {
      const prior = previous.cells.find((p) => p.id === cell.id);
      return {
        id: cell.id,
        performanceMedianDelta: prior
          ? cell.batches[0].performance.median - prior.batches[0].performance.median
          : null,
      };
    }),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  const artifacts = JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`,
      ],
      { encoding: 'utf8' }
    )
  );
  const previous = artifacts.artifacts.find(
    (a) =>
      !a.expired &&
      String(a.workflow_run.id) !== process.env.GITHUB_RUN_ID &&
      a.workflow_run.head_branch === 'main'
  );
  if (previous) {
    mkdirSync('.scratch/quality-baseline', { recursive: true });
    execFileSync('gh', [
      'run',
      'download',
      String(previous.workflow_run.id),
      '--name',
      name,
      '--dir',
      resolve('.scratch/quality-baseline'),
    ]);
    console.log(
      `Retrieved predecessor ${JSON.parse(readFileSync('.scratch/quality-baseline/summary.json')).commit}`
    );
  } else console.log('No previous main summary for this cell profile');
}
