// Every third-party action in .github/workflows runs pinned to a full commit sha with its version
// as a comment (TODO #18b): a tag can be moved by whoever controls the action, a commit cannot,
// and release.yml runs with write access to packages and releases. Docker images in `run:` steps
// are pinned by tag and are out of scope here. verify.yml also runs with a read-only token, and
// every job of every workflow has a timeout (testing.md rule 2: a hung run must not hold a runner
// for the six-hour default). release.yml writes packages, so it counts as much as the gate does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll, readJson, walk } from '../lib/repo.mjs';

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

// These workflows use a deliberately small YAML shape: two-space jobs and literal run blocks.
// Execute the actual aggregator shell with dependency substitutions, rather than duplicating
// its decision in a JavaScript predicate that could pass while GitHub turns a missing job green.
const verifyWorkflow = () => workflows().find((w) => w.path === 'verify.yml').text;
const jobsOf = (text) =>
  Object.fromEntries(
    [
      ...text
        .split(/^jobs:\n/m)[1]
        .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm),
    ].map(([, name, body]) => [name, body])
  );
const runBlock = (step) => {
  const body = /        run: \|\n((?:          .*\n|\n)+)/.exec(step)?.[1];
  assert.ok(body, 'literal executable run block');
  return body.replace(/^          /gm, '');
};
const stepsOf = (job) => job.split(/(?=^      - (?:name|uses|run):)/m).slice(1);

test('only explicitly allowed non-production jobs select the fake assist provider', () => {
  const allowed = ['checks', 'browsers'];
  for (const { path, text } of workflows()) {
    let outsideFixtures = text;
    for (const [name, job] of Object.entries(jobsOf(text))) {
      if (path === 'verify.yml' && allowed.includes(name)) {
        outsideFixtures = outsideFixtures.replace(job, '');
        const env = /^    env:\n([\s\S]*?)(?=^    steps:)/m.exec(job)?.[1];
        assert.ok(env, `${name}: job-level fixtures`);
        assert.match(env, /^      ASSIST_PROVIDER: fake$/m);
        assert.match(env, /^      E2E_REQUIRED: '1'$/m);
        assert.doesNotMatch(job, /NODE_ENV:\s*['"]?production/);
      } else assert.doesNotMatch(job, /ASSIST_PROVIDER/, `${path}/${name}: production default`);
    }
    assert.doesNotMatch(outsideFixtures, /ASSIST_PROVIDER/, `${path}: no inherited fake provider`);
  }
});

test('local verify and CI cover every original command and both existing browser projects', () => {
  const { scripts } = readJson('package.json');
  const commands = [
    'format:check',
    'lint:deps',
    'lint:infra',
    'typecheck',
    'test:collect',
    'test',
    'build',
  ];
  assert.equal(scripts['verify:checks'], commands.map((name) => `npm run ${name}`).join(' && '));
  assert.equal(scripts.verify, 'npm run verify:checks && npm run test:e2e');
  assert.equal(scripts['test:e2e'], 'node scripts/e2e/e2e.mjs');
  const jobs = jobsOf(verifyWorkflow());
  const checks = runBlock(stepsOf(jobs.checks).find((s) => /Static, adapter/.test(s)));
  assert.deepEqual(
    checks.split('\n').filter((line) => /^(npm|npx) /.test(line)),
    [
      'npm ci',
      'npx playwright install --with-deps chromium',
      'npm run migrate -w @mycel/db',
      'npm run verify:checks',
    ]
  );
  assert.doesNotMatch(jobs.checks, /npm run test:e2e/);
  assert.match(jobs.checks, /Signed-off-by on every commit/);
  assert.match(jobs.checks, /Merged migrations are unchanged/);
  const projects = /project: \[([^\]]+)\]/.exec(jobs.browsers)[1].split(', ');
  const config = readAll(['apps/web/playwright.config.ts'])[0].text;
  assert.deepEqual(
    projects.sort(),
    [...config.matchAll(/name: '([^']+)'/g)].map((m) => m[1]).sort()
  );
  assert.deepEqual(projects, ['a11y', 'no-js']);
  assert.match(jobs.browsers, /fail-fast: false/);
  const browser = runBlock(stepsOf(jobs.browsers).find((s) => /Build and run browser/.test(s)));
  assert.deepEqual(
    browser.split('\n').filter((line) => /^(npm|npx) /.test(line)),
    [
      'npm ci',
      'npx playwright install --with-deps chromium',
      'npm run migrate -w @mycel/db',
      'npm run build',
      'npm run test:e2e -- --project=${{ matrix.project }} --reporter=list',
    ]
  );
});

// A slow Ubuntu mirror cost a whole job with no test red. The cached packages must arrive before
// the install, and a stalled cache must fall back to the download instead of eating the job.
test('browser system packages reach apt from a cache before the install, in every job that installs', () => {
  const jobs = jobsOf(verifyWorkflow());
  for (const name of ['checks', 'browsers']) {
    const steps = stepsOf(jobs[name]);
    const at = (pattern) => steps.findIndex((s) => pattern.test(s));
    const restore = at(/name: Restore browser system packages/);
    const hand = at(/name: Hand restored packages to apt/);
    const install = at(/playwright install --with-deps chromium/);
    const keep = at(/name: Keep downloaded packages for the cache/);
    assert.ok(restore >= 0 && restore < hand && hand < install && install < keep, name);
    assert.match(steps[restore], /SEGMENT_DOWNLOAD_TIMEOUT_MINS: '1'/);
    assert.match(steps[restore], /timeout-minutes: 2\b/);
    assert.match(steps[keep], /cache-hit != 'true'/);
    // `env.ImageOS` is empty in an expression: the key must name the image the job pins.
    assert.match(steps[restore], /key: browser-debs-ubuntu-24\.04-v\d+$/m);
  }
});

test('checks install their measured-DOM runtime before running infrastructure gates', () => {
  const job = jobsOf(verifyWorkflow()).checks;
  const execution = stepsOf(job).find((s) => /timeout-minutes: 12/.test(s));
  const shell = runBlock(execution);
  // Model a fresh runner, not this machine's warm Playwright cache. Execute the real step
  // with external command stand-ins: npm ci clears the runtime, installation provisions it,
  // and verify needs it. A missing/late/failed install must never reach a green verification.
  const commands = `
    npm() {
      case "$*" in
        ci) rm -f chromium-ready ;;
        'run migrate -w @mycel/db') : ;;
        'run verify:checks') touch verify-ran; test -f chromium-ready || return 42 ;;
        *) return 43 ;;
      esac
    }
    npx() {
      test "$*" = 'playwright install --with-deps chromium' || return 44
      touch chromium-ready
    }
  `;
  const install = 'npx playwright install --with-deps chromium';
  for (const [name, body, status] of [
    ['provisioned', shell, 0],
    ['missing', shell.replace(install, ':'), 42],
    ['late', shell.replace(install, ':') + '\n' + install, 42],
    ['failed', shell.replace(install, 'false'), 1],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'mycel-ci-runtime-'));
    try {
      const result = spawnSync(
        'bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', commands + body],
        { cwd: dir }
      );
      assert.equal(result.status, status, name);
      if (name === 'failed')
        assert.equal(spawnSync('test', ['-f', join(dir, 'verify-ran')]).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('protected verify rejects failure, cancellation, skipping and missing dependency results', () => {
  const jobs = jobsOf(verifyWorkflow());
  const required = ['checks', 'browsers', 'security', 'image', 'compose'];
  assert.match(jobs.verify, /^    if: always\(\)$/m);
  const needs = /needs: \[([^\]]+)\]/.exec(jobs.verify)[1].split(', ');
  assert.deepEqual(needs.sort(), [...required].sort());
  assert.deepEqual(Object.keys(jobs).sort(), [...required, 'verify'].sort());
  const shell = runBlock(jobs.verify);
  const execute = (results) =>
    spawnSync('bash', [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      shell.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, name) => results[name] ?? ''),
    ]).status;
  const green = Object.fromEntries(required.map((name) => [name, 'success']));
  assert.equal(execute(green), 0);
  for (const name of required) {
    for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
      assert.notEqual(execute({ ...green, [name]: result }), 0, `${name}: ${result}`);
    }
  }
});

test('layer jobs own services and reserve time for unconditional, distinct retained evidence', () => {
  const jobs = jobsOf(verifyWorkflow());
  assert.match(jobs.checks, /image: rustfs\/rustfs:1\.0\.1/);
  assert.doesNotMatch(jobs.browsers, /rustfs|BLOB_S3/);
  for (const key of [
    'ENDPOINT',
    'REGION',
    'BUCKET',
    'ACCESS_KEY_ID',
    'SECRET_ACCESS_KEY',
    'FORCE_PATH_STYLE',
  ])
    assert.match(jobs.checks, new RegExp(`^      BLOB_S3_${key}: .+$`, 'm'));
  for (const name of ['checks', 'browsers']) {
    assert.match(
      jobs[name],
      /^      DATABASE_URL: postgres:\/\/mycel:mycel@localhost:5432\/mycel$/m
    );
    assert.match(jobs[name], /^      APP_DATABASE_URL: postgres:\/\/mycel_app:/m);
    assert.match(jobs[name], /^      AUTH_DATABASE_URL: postgres:\/\/mycel_authenticator:/m);
  }
  const names = [];
  for (const name of ['checks', 'browsers']) {
    const job = jobs[name];
    assert.match(job, /^    runs-on: ubuntu-24\.04$/m);
    assert.match(job, /^    timeout-minutes: 15$/m);
    assert.match(job, /^    services:\n      postgres:\n        image: postgres:16\.15-alpine/m);
    assert.doesNotMatch(job, /container:|environment:|needs:|continue-on-error/);
    const steps = stepsOf(job);
    const execution = steps.find((s) => /timeout-minutes: 12/.test(s));
    assert.ok(execution, `${name}: bounded execution includes install, migration and test`);
    const upload = steps.find((s) => /uses: actions\/upload-artifact@/.test(s));
    assert.match(upload, /if: always\(\)/);
    assert.match(upload, /timeout-minutes: 1/);
    assert.match(upload, /retention-days: 7/);
    assert.match(upload, /include-hidden-files: true/);
    assert.match(upload, /if-no-files-found: error/);
    assert.match(upload, /\.scratch\/ci\//);
    if (name === 'browsers') assert.match(upload, /apps\/web\/test-results\//);
    names.push(/          name: (.+)/.exec(upload)[1]);
    // Run the actual blocks under the selected Bash, including dynamic PS4, xtrace and
    // errexit. Only external dependency commands are inert: a local warm cache must not be
    // needed to exercise success, explicit exit and implicit command failure on each platform.
    const shell = runBlock(execution).replaceAll('${{ matrix.project }}', 'a11y');
    assert.match(shell, /^PS4='\+ \$\(date -u \+%FT%TZ\) '$/m);
    assert.match(shell, /^set -x$/m);
    const commands = [...shell.matchAll(/^(?:npm|npx) .+$/gm)].map(([command]) => command);
    assert.ok(commands.length > 0);
    for (const [status, failure] of [
      [0, ''],
      [23, 'exit 23'],
      [1, 'false'],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'mycel-ci-evidence-'));
      try {
        let commandIndex = 0;
        const probe = shell.replace(/^(?:npm|npx) .+$/gm, (command) => {
          const printed = `printf '%s\\n' '${command.replaceAll("'", "'\\''")}'`;
          return commandIndex++ === 0 && failure
            ? `${printed}; printf 'controlled dependency failure\\n'; ${failure}`
            : printed;
        });
        const result = spawnSync(
          'bash',
          ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', probe],
          { cwd: dir, encoding: 'utf8' }
        );
        assert.equal(result.status, status, `${name}: ${failure || 'success'}`);
        const log = readFileSync(
          join(dir, '.scratch/ci', name === 'checks' ? 'checks.log' : 'browser-a11y.log'),
          'utf8'
        );
        assert.equal(log, result.stdout, 'uploader retains the exact complete execution output');
        assert.equal(result.stderr, '', 'all tracing and errors are captured in the retained log');
        assert.match(log, /\+ \d{4}-\d{2}-\d{2}T.* printf/);
        for (const command of status === 0 ? commands : commands.slice(0, 1))
          assert.ok(log.includes(`\n${command}\n`), `${name}: retained command ${command}`);
        if (status !== 0) assert.match(log, /controlled dependency failure/);
        const label = name === 'checks' ? 'checks' : 'browser';
        assert.match(
          log,
          new RegExp(`\\n\\d{4}-\\d{2}-\\d{2}T[^\\n]+ ${label} exit=${status}\\n$`)
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  assert.equal(new Set(names).size, 2);
  assert.ok(names.some((name) => name.includes('${{ matrix.project }}')));
});

/** The jobs of a workflow's text, each with its indented body; the first line names it. */
const jobBodies = (text) => text.split(/^jobs:\n/m)[1].split(/^(?=  [\w-]+:\n)/m);

/** The jobs without a job-level timeout; a step's `timeout-minutes` is indented further. */
const withoutTimeout = (text) =>
  jobBodies(text)
    .filter((job) => !/^    timeout-minutes: \d+$/m.test(job))
    .map((job) => job.split(':')[0].trim());

test('verify.yml runs with a read-only token', () => {
  const workflow = workflows().find((w) => w.path === 'verify.yml').text;
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
});

test('every job of every workflow has a timeout', () => {
  const found = workflows();
  assert.ok(found.length >= 4, `found ${found.length} workflows`);
  const without = found.flatMap(({ path, text }) =>
    withoutTimeout(text).map((job) => `${path}: ${job}`)
  );
  assert.deepEqual(without, []);
  const verify = found.find((w) => w.path === 'verify.yml').text;
  assert.ok(jobBodies(verify).length >= 4, 'found the jobs of verify.yml');
});

test('a job with only a step timeout has no timeout', () => {
  const text = [
    'jobs:',
    '  covered:',
    '    timeout-minutes: 5',
    '    steps:',
    '      - run: a',
    '  bare:',
    '    steps:',
    '      - run: b',
    '        timeout-minutes: 3',
    '',
  ].join('\n');
  assert.deepEqual(withoutTimeout(text), ['bare']);
});
