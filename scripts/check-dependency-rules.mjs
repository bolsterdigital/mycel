#!/usr/bin/env node
// Enforces ADR 001 (dependency direction) and ADR 006 (licence allow-list) at verify time.
//
// Why a 100-line script and not eslint-plugin-boundaries or dependency-cruiser: the rules
// are three sentences long, the script has zero dependencies, and agents can read it in
// one screen. If the rule set grows past what fits here, switch to dependency-cruiser.
//
// Rules:
//   1. packages/core imports no other workspace and none of the I/O libraries listed below.
//   2. Adapters and fronts may import packages/core; they may not import each other.
//      (apps/web and packages/mcp may import packages/api only for its composition root,
//      `@mycel/api/compose`, which wires adapters into the core; see ALLOWED.)
//   3. Every workspace package.json declares license AGPL-3.0-only, and every installed
//      production dependency has a licence from ALLOWED_LICENSES.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspaces = ['packages', 'apps']
  .flatMap((dir) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((n) => join(dir, n)) : []
  )
  .filter((p) => existsSync(join(root, p, 'package.json')));

const pkgName = (ws) => JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8')).name;
const names = Object.fromEntries(workspaces.map((ws) => [ws, pkgName(ws)]));

const CORE = 'packages/core';
const IO_LIBS = [
  'pg',
  'kysely',
  'hono',
  '@hono/',
  '@sveltejs/',
  'svelte',
  '@modelcontextprotocol/',
  'node:fs',
  'node:http',
  'node:net',
  'node:child_process',
  'undici',
  'nodemailer',
  '@mollie/',
];
const ALLOWED = {
  'apps/web': ['packages/core', 'packages/api'],
  'packages/api': ['packages/core', 'packages/db', 'packages/mail-tem'],
  'packages/mcp': ['packages/core', 'packages/api'],
  'packages/db': ['packages/core'],
  'packages/mail-tem': ['packages/core'],
  'packages/core': [],
};
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'GPL-3.0',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'Python-2.0',
  // argparse 3 relabelled its Python-2.0 licence as PSF-2.0; same text, GPL-compatible per the FSF.
  'PSF-2.0',
]);

const errors = [];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'build', '.svelte-kit'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|js|mjs|svelte)$/.test(entry)) yield full;
  }
}

const importRe = /(?:from|import)\s*['"]([^'"]+)['"]/g;
for (const ws of workspaces) {
  const srcDir = join(root, ws, 'src');
  if (!existsSync(srcDir)) continue;
  const allowed = ALLOWED[ws] ?? ['packages/core'];
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(importRe)) {
      const rel = relative(root, file);
      for (const [otherWs, otherName] of Object.entries(names)) {
        if (otherWs === ws) continue;
        if (spec === otherName || spec.startsWith(otherName + '/')) {
          if (!allowed.includes(otherWs))
            errors.push(`${rel}: imports ${otherName} (not allowed from ${ws})`);
        }
      }
      if (
        (ws === 'apps/web' || ws === 'packages/mcp') &&
        spec.startsWith('@mycel/api') &&
        spec !== '@mycel/api/compose'
      ) {
        errors.push(`${rel}: imports ${spec}; only @mycel/api/compose is allowed from ${ws}`);
      }
      if (ws === CORE && IO_LIBS.some((lib) => spec === lib || spec.startsWith(lib))) {
        errors.push(`${rel}: core imports I/O library ${spec} (ADR 001)`);
      }
    }
  }
}

for (const ws of workspaces) {
  const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
  if (pkg.license !== 'AGPL-3.0-only')
    errors.push(`${ws}/package.json: license must be AGPL-3.0-only (ADR 006)`);
}

// Licence check over installed production dependencies (skipped when node_modules is absent).
const nm = join(root, 'node_modules');
if (existsSync(nm)) {
  const seen = new Set();
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (entry.startsWith('@')) {
        visit(full);
        continue;
      }
      const pj = join(full, 'package.json');
      if (!existsSync(pj) || seen.has(full)) continue;
      seen.add(full);
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const lic =
        typeof pkg.license === 'string'
          ? pkg.license
          : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? 'UNKNOWN');
      const ok = lic
        .split(/\s+OR\s+|\(|\)|\s+AND\s+/)
        .filter(Boolean)
        .some((l) => ALLOWED_LICENSES.has(l.trim()));
      if (!ok && !isDevOnly(pkg.name))
        errors.push(
          `dependency ${pkg.name}@${pkg.version}: licence ${lic} not in allow-list (ADR 006)`
        );
    }
  };
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const devOnly = new Set(Object.keys(rootPkg.devDependencies ?? {}));
  for (const ws of workspaces) {
    const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.devDependencies ?? {})) devOnly.add(d);
  }
  function isDevOnly(name) {
    return devOnly.has(name);
  }
  visit(nm);
}

if (errors.length) {
  console.error('Dependency rules violated:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`dependency rules ok (${workspaces.length} workspaces)`);
