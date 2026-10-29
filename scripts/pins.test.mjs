// One version per runtime (TODO #75): Node, Postgres and Caddy are pinned in several places that
// have to agree, because CI measures one version and production runs another otherwise. `.nvmrc`
// is the Node source (setup-node reads it; the Dockerfile default and the quality workflow,
// whose evidence records the version literally, must equal it); the Postgres servers run the
// minor the backup client is pinned to; production Caddy is the release the quality workflow
// measures. Run by `npm run lint:infra`, offline.
// Rejected: generating the files from one config (a build step for four lines) and floating tags
// (`16-alpine`, `caddy:2`), which let a pull change what was measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAll, walk } from './lib/repo.mjs';

/** Every pin, as `{ where, runtime, version }`, from `files` (`[{ path, text }]`). */
export function pins(files) {
  const out = [];
  const add = (path, runtime, re, text) => {
    for (const m of text.matchAll(re)) out.push({ where: path, runtime, version: m[1] });
  };
  for (const { path, text } of files) {
    if (path === '.nvmrc') out.push({ where: path, runtime: 'node', version: text.trim() });
    add(path, 'node', /^ARG NODE_VERSION=(\S+)$/gm, text);
    add(path, 'node', /node-version: '([^']+)'/g, text);
    add(path, 'postgres', /image: postgres:([\w.-]+)/g, text);
    add(path, 'postgres', /postgresql\d+-client~([\d.]+)/g, text);
    add(path, 'caddy', /image: caddy:([\w.-]+)/g, text);
    add(path, 'caddy', /caddy\/releases\/download\/v([\d.]+)\//g, text);
  }
  return out;
}

/** The runtimes whose pins disagree or float, as messages. Postgres compares `<major>.<minor>`. */
export function disagreements(found) {
  const norm = { node: (v) => v, caddy: (v) => v, postgres: (v) => v.replace(/-alpine$/, '') };
  const errors = [];
  for (const runtime of Object.keys(norm)) {
    const own = found.filter((p) => p.runtime === runtime);
    for (const p of own)
      if (!/^\d+\.\d+/.test(norm[runtime](p.version)))
        errors.push(`${p.where}: ${runtime} ${p.version} floats; pin a minor`);
    const versions = new Set(own.map((p) => norm[runtime](p.version)));
    if (versions.size > 1)
      errors.push(
        `${runtime} pins disagree: ${own.map((p) => `${p.where} ${p.version}`).join(', ')}`
      );
  }
  return errors;
}

const sources = () =>
  readAll([
    '.nvmrc',
    'Dockerfile',
    'docker/backup/Dockerfile',
    ...walk('', { match: (p) => /^compose[\w.]*\.ya?ml$/.test(p), skip: () => true }),
    ...walk('.github/workflows', { match: (p) => /\.ya?ml$/.test(p) }),
  ]);

test('Node, Postgres and Caddy are each pinned to one version everywhere', () => {
  const found = pins(sources());
  for (const runtime of ['node', 'postgres', 'caddy'])
    assert.ok(found.filter((p) => p.runtime === runtime).length >= 2, `found the ${runtime} pins`);
  assert.deepEqual(disagreements(found), []);
});

test('a floating tag and a second version are caught', () => {
  const found = pins([
    { path: '.nvmrc', text: '22.22.0\n' },
    { path: 'Dockerfile', text: 'ARG NODE_VERSION=22\n' },
    { path: 'compose.yml', text: 'image: postgres:16.15-alpine\nimage: caddy:2\n' },
    { path: 'backup/Dockerfile', text: 'postgresql16-client~16.15 \\' },
    { path: 'ci.yml', text: "node-version: '22.22.0'\ncaddy/releases/download/v2.10.2/x" },
  ]);
  assert.deepEqual(disagreements(found), [
    'Dockerfile: node 22 floats; pin a minor',
    'node pins disagree: .nvmrc 22.22.0, Dockerfile 22, ci.yml 22.22.0',
    'compose.yml: caddy 2 floats; pin a minor',
    'caddy pins disagree: compose.yml 2, ci.yml 2.10.2',
  ]);
});
