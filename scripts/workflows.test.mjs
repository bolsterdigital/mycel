// Every third-party action in .github/workflows runs pinned to a full commit sha with its version
// as a comment (TODO #18b): a tag can be moved by whoever controls the action, a commit cannot,
// and release.yml runs with write access to packages and releases. Docker images in `run:` steps
// are pinned by tag and are out of scope here. verify.yml also runs with a read-only token and a
// timeout per job (testing.md rule 2: a hung run must not hold a runner for the six-hour default).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAll, walk } from './lib/repo.mjs';

/** `[{ path, text }]` for every workflow, `path` as `<name>.yml`. */
const workflows = () =>
  readAll(walk('.github/workflows', { match: (p) => /\.ya?ml$/.test(p) })).map(
    ({ path, text }) => ({ path: path.slice('.github/workflows/'.length), text })
  );

test('every `uses:` is pinned to a commit sha with a version comment', () => {
  const unpinned = [];
  for (const { path: file, text } of workflows()) {
    text.split('\n').forEach((line, i) => {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m || m[1].startsWith('./')) return;
      if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d/.test(m[2]))
        unpinned.push(`${file}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(unpinned, []);
});

test('only the non-production verify job selects the fake assist provider', () => {
  const all = workflows();
  const workflow = all.find((w) => w.path === 'verify.yml').text;
  const verifyJob = workflow.split(/^  verify:\n/m)[1]?.split(/^  [\w-]+:\n/m)[0];
  assert.ok(verifyJob, 'verify job must exist');
  const jobEnv = /^    env:\n([\s\S]*?)(?=^    steps:)/m.exec(verifyJob)?.[1];
  assert.ok(jobEnv, 'provider must be inherited by all verify steps');
  assert.match(jobEnv, /^      ASSIST_PROVIDER: fake$/m);
  assert.doesNotMatch(verifyJob, /NODE_ENV:\s*['"]?production/);

  // Image/compose/release use the production default, never the browser fixture provider.
  for (const { path: file, text: contents } of all) {
    const otherJobs = file === 'verify.yml' ? contents.replace(verifyJob, '') : contents;
    assert.doesNotMatch(otherJobs, /ASSIST_PROVIDER/, `${file}: provider outside verify job`);
  }
});

test('verify.yml runs with a read-only token and every job has a timeout', () => {
  const workflow = workflows().find((w) => w.path === 'verify.yml').text;
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  const jobs = workflow.split(/^jobs:\n/m)[1].split(/^(?=  [\w-]+:\n)/m);
  const without = jobs
    .filter((job) => !/^    timeout-minutes: \d+$/m.test(job))
    .map((job) => job.split(':')[0].trim());
  assert.deepEqual(without, []);
  assert.ok(jobs.length >= 4, `found ${jobs.length} jobs`);
});
