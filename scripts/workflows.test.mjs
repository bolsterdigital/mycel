// Every third-party action in .github/workflows runs pinned to a full commit sha with its version
// as a comment (TODO #18b): a tag can be moved by whoever controls the action, a commit cannot,
// and release.yml runs with write access to packages and releases. Docker images in `run:` steps
// are pinned by tag and are out of scope here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

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
