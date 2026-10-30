// Dead exports can only go down (TODO #53 PR 6): the repo against scripts/gates/dead-exports.baseline.json,
// plus the resolution rules of dead-exports.mjs on small in-memory trees. Run by
// `npm run lint:infra`, offline.
// Rejected: a count instead of a list (a removed dead export and a new one cancel out silently).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, currentDead, deadExports, readBaseline } from './dead-exports.mjs';

test('no export is dead beyond the baseline, and the baseline holds nothing alive', () => {
  const dead = currentDead();
  const baseline = new Set(readBaseline());
  const added = dead.filter((d) => !baseline.has(d));
  const revived = [...baseline].filter((d) => !dead.includes(d));
  assert.deepEqual(
    added,
    [],
    'new dead exports: use them, delete them, or drop the `export` keyword (not the baseline)'
  );
  assert.deepEqual(revived, [], `no longer dead: remove these lines from ${BASELINE}`);
});

const pkgs = { '@x/lib': 'packages/lib/src/index.ts', 'apps/web:#lib/*': 'apps/web/src/lib/*' };

test('an import, a barrel and a re-export chain keep the declaring export alive', () => {
  const files = {
    'packages/lib/src/index.ts': "export * from './a.js';\nexport { b as bee } from './b.js';",
    'packages/lib/src/a.ts': 'export const used = 1;\nexport const unused = 2;',
    'packages/lib/src/b.ts': 'export const b = 1;\nexport const c = 2;',
    'packages/app/src/main.ts': "import { used, bee } from '@x/lib';\nconsole.log(used, bee);",
  };
  assert.deepEqual(deadExports(files, pkgs), [
    'packages/lib/src/a.ts#unused',
    'packages/lib/src/b.ts#c',
  ]);
});

test('a destructured dynamic import counts by name, a bare one keeps everything', () => {
  const lib = { 'packages/lib/src/index.ts': 'export const a = 1;\nexport const b = 2;' };
  const named = { 'apps/web/e2e/x.spec.ts': "const { a } = await import('@x/lib');" };
  const bare = { 'apps/web/e2e/x.spec.ts': "const lib = await import('@x/lib');" };
  assert.deepEqual(deadExports({ ...lib, ...named }, pkgs), ['packages/lib/src/index.ts#b']);
  assert.deepEqual(deadExports({ ...lib, ...bare }, pkgs), []);
});

test('subpath imports, tests and own-file use count; routes are not checked', () => {
  const files = {
    'apps/web/src/lib/server/s.ts':
      'export type Row = { id: string };\nexport const read = (): Row => ({ id: "" });\nexport const gone = 1;\nexport const tested = 1;',
    'apps/web/src/lib/server/s.test.ts': "import { tested } from './s.js';",
    'apps/web/src/routes/+page.server.ts':
      "import { read } from '#lib/server/s.js';\nexport const load = () => read();",
  };
  assert.deepEqual(deadExports(files, pkgs), ['apps/web/src/lib/server/s.ts#gone']);
});

test('a property with the same name is not a use', () => {
  const files = {
    'packages/lib/src/a.ts': 'export const name = 1;\nconst o = { name: 2 };\no.name;',
  };
  assert.deepEqual(deadExports(files, pkgs), ['packages/lib/src/a.ts#name']);
});
