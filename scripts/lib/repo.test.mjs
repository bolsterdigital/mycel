// Every gate stays on scripts/lib/repo.mjs (TODO #75): a gate named in `lint:infra` or `lint:deps`,
// and every script module it imports or spawns, finds the root, walks a tree and lists tracked
// files through the shared helpers, never with its own `readdirSync`, `new URL('..')` or
// `git ls-files`. Plus the helpers' own rules on a fixture tree, and testing.md § Gates naming
// every gate. Run by `npm run lint:infra`, offline.
// Rejected: a list of gate files kept by hand (a new gate would simply be missing from it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { readAll, readJson, staleEntries, stripComments, walk } from './repo.mjs';

/** What a gate does itself instead of asking the shared module. */
export const OWN_PLUMBING = [
  { name: 'its own directory walk', pattern: /\breaddirSync\b/ },
  { name: 'its own root resolver', pattern: /new URL\(\s*['"]\.\.(\/['"]|['"])/ },
  { name: 'its own tracked-file list', pattern: /['"]ls-files['"]/ },
];

/** `path: <name>` for every gate source that does one of `OWN_PLUMBING`. */
export const ownPlumbing = (files) =>
  files.flatMap(({ path, text }) =>
    OWN_PLUMBING.filter(({ pattern }) => pattern.test(stripComments(text))).map(
      ({ name }) => `${path} has ${name}; use scripts/lib/repo.mjs`
    )
  );

/** Every path the `lint:infra` and `lint:deps` scripts name, globs included. */
function lintWords() {
  const { scripts } = readJson('package.json');
  return `${scripts['lint:infra']} ${scripts['lint:deps']}`
    .split(/\s+/)
    .filter((word) => word.endsWith('.mjs'));
}

/**
 * The gate files: every plain `.mjs` path in the `lint:infra` and `lint:deps` scripts, plus the
 * script modules they import or spawn.
 */
function gateFiles() {
  const named = lintWords().filter((word) => !word.includes('*'));
  const all = new Set(named);
  for (const { path, text } of readAll(named))
    for (const [, spec] of text.matchAll(/(?:from |new URL\()'((?:\.\.?\/)?[\w./-]+\.mjs)'/g))
      if (!spec.includes('lib/') && !spec.includes('fixtures/'))
        all.add(posix.normalize(posix.join(dirname(path), spec)));
  return [...all].filter((path) => !path.startsWith('scripts/lib/')).sort();
}

test('every gate uses scripts/lib/repo.mjs for walking, the root and tracked files', () => {
  const gates = gateFiles();
  assert.ok(gates.includes('scripts/gates/check-owner-strings.mjs'), 'follows imports and spawns');
  assert.ok(gates.length > 15, `found ${gates.length} gate files`);
  assert.deepEqual(ownPlumbing(readAll(gates)), []);
});

test('testing.md § Gates names every gate', () => {
  const doc = readAll(['docs/architecture/testing.md'])[0].text;
  const gates = doc.slice(doc.indexOf('\n## Gates\n'), doc.indexOf('\n## Local database\n'));
  assert.deepEqual(
    lintWords().filter((word) => !gates.includes(`\`${word}\``)),
    []
  );
});

test('the rule sees a gate with its own walk, root or file list', () => {
  const file = (text) => ({ path: 'scripts/x.test.mjs', text });
  assert.deepEqual(
    ownPlumbing([
      file("const root = fileURLToPath(new URL('..', import.meta.url));"),
      file("readdirSync(dir).filter((f) => f.endsWith('.yml'));"),
      file("execFileSync('git', ['ls-files', '-z']);"),
      file("// readdirSync is not used here\nconst a = new URL('./x.json', import.meta.url);"),
    ]),
    [
      'scripts/x.test.mjs has its own root resolver; use scripts/lib/repo.mjs',
      'scripts/x.test.mjs has its own directory walk; use scripts/lib/repo.mjs',
      'scripts/x.test.mjs has its own tracked-file list; use scripts/lib/repo.mjs',
    ]
  );
});

test('walk skips build output, skipped directories and symlinks, and sorts', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-lib-'));
  try {
    const put = (path, text = '') => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put('src/b.ts');
    put('src/a/c.ts');
    put('src/a/c.md');
    put('src/node_modules/x/index.ts');
    put('src/dist/out.ts');
    put('src/private/secret.ts');
    symlinkSync(join(root, 'src/b.ts'), join(root, 'src/link.ts'));
    const found = walk('src', {
      root,
      match: (p) => p.endsWith('.ts'),
      skip: (p) => p === 'src/private',
    });
    assert.deepEqual(found, ['src/a/c.ts', 'src/b.ts']);
    assert.deepEqual(walk('missing', { root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stripComments keeps lines and URLs; staleEntries names what nothing needs', () => {
  assert.equal(
    stripComments('a /* b\nc */ d\ne // f\ng = "https://x"'),
    'a     \n     d\ne \ng = "https://x"'
  );
  assert.deepEqual(
    staleEntries(['x', 'y'], (e) => e === 'x', 'LIST'),
    ['LIST: y is no longer needed; remove the entry']
  );
});
