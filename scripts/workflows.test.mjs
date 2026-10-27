// Every third-party action in .github/workflows runs pinned to a full commit sha with its version
// as a comment (TODO #18b): a tag can be moved by whoever controls the action, a commit cannot,
// and release.yml runs with write access to packages and releases. Docker images in `run:` steps
// are pinned by tag and are out of scope here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockExamples } from './e2e-block-examples.mjs';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

test('browser seed examples preserve each registry definition version, name, type and props', () => {
  const v1 = { title: { nl: 'Bestaand', en: 'Existing' } };
  const v2 = { width: 'wide', title: { nl: 'Nieuw', en: 'New' } };
  const examples = blockExamples({
    heading: { version: 1, examples: [{ name: 'heading-default', props: v1 }] },
    faq: { version: 2, examples: [{ name: 'faq-wide-probe', props: v2 }] },
  });
  assert.deepEqual(examples, {
    'heading-default': { type: 'heading', version: 1, props: v1 },
    'faq-wide-probe': { type: 'faq', version: 2, props: v2 },
  });
  assert.strictEqual(examples['heading-default'].props, v1);
  assert.strictEqual(examples['faq-wide-probe'].props, v2);
});

test('every `uses:` is pinned to a commit sha with a version comment', () => {
  const unpinned = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    readFileSync(dir + file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1].startsWith('./')) return;
        if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d/.test(m[2]))
          unpinned.push(`${file}:${i + 1} ${m[1]}`);
      });
  }
  assert.deepEqual(unpinned, []);
});

test('only the non-production verify job selects the fake assist provider', () => {
  const workflow = readFileSync(dir + 'verify.yml', 'utf8');
  const verifyJob = workflow.split(/^  verify:\n/m)[1]?.split(/^  [\w-]+:\n/m)[0];
  assert.ok(verifyJob, 'verify job must exist');
  const jobEnv = /^    env:\n([\s\S]*?)(?=^    steps:)/m.exec(verifyJob)?.[1];
  assert.ok(jobEnv, 'provider must be inherited by all verify steps');
  assert.match(jobEnv, /^      ASSIST_PROVIDER: fake$/m);
  assert.doesNotMatch(verifyJob, /NODE_ENV:\s*['"]?production/);

  // Image/compose/release use the production default, never the browser fixture provider.
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const contents = readFileSync(dir + file, 'utf8');
    const otherJobs = file === 'verify.yml' ? contents.replace(verifyJob, '') : contents;
    assert.doesNotMatch(otherJobs, /ASSIST_PROVIDER/, `${file}: provider outside verify job`);
  }
});
