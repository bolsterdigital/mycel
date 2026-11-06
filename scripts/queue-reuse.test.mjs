// The queue reuses a PR run only on the exact tree with a passed newest run; every other answer
// is a full run. A fake API stands in for GitHub, so the decision is tested without the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './queue-reuse.mjs';

const sha = (c) => c.repeat(40);
const queue = {
  head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${sha('b')}`,
  head_sha: sha('c'),
};
const world = (over = {}) => {
  const state = {
    head: sha('d'),
    trees: { [sha('c')]: 't1', [sha('d')]: 't1' },
    runs: [{ run_number: 3, status: 'completed', conclusion: 'success', html_url: 'u3' }],
    ...over,
  };
  return async (path) => {
    if (path === 'repos/o/r/pulls/7') return { head: { sha: state.head } };
    const commit = /git\/commits\/(\w+)$/.exec(path)?.[1];
    if (commit) return { tree: { sha: state.trees[commit] } };
    if (path.startsWith(`repos/o/r/actions/workflows/verify.yml/runs?head_sha=${state.head}`))
      return { workflow_runs: state.runs };
    throw new Error(`unexpected ${path}`);
  };
};
const run = (api, input = {}) =>
  decide({
    event: 'merge_group',
    mergeGroup: queue,
    workflow: 'verify.yml',
    repository: 'o/r',
    api,
    ...input,
  });

test('the same tree with a passed newest PR run is reused', async () => {
  assert.deepEqual(await run(world()), {
    reused: true,
    reason: `same tree as PR #7 head ${sha('d')}, whose verify.yml run passed`,
    run: 'u3',
  });
});

test('every other state runs in full', async () => {
  const refused = [
    [world(), { event: 'pull_request' }],
    [world(), { mergeGroup: { head_ref: 'refs/heads/main', head_sha: sha('c') } }],
    [world(), { mergeGroup: { ...queue, head_sha: 'nope' } }],
    [world({ head: undefined }), {}],
    [world({ trees: { [sha('c')]: 't2', [sha('d')]: 't1' } }), {}],
    [world({ trees: {} }), {}],
    [world({ runs: [] }), {}],
    [world({ runs: [{ run_number: 1, status: 'in_progress', conclusion: null }] }), {}],
    [
      world({
        runs: [
          { run_number: 3, status: 'completed', conclusion: 'success' },
          { run_number: 4, status: 'completed', conclusion: 'failure' },
        ],
      }),
      {},
    ],
  ];
  for (const [api, input] of refused) assert.equal((await run(api, input)).reused, false);
});
