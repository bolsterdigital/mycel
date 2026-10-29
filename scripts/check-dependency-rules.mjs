#!/usr/bin/env node
// Enforces ADR 001 (dependency direction) and ADR 006 (licence allow-list) at verify time.
//
// Why a script and not eslint-plugin-boundaries or dependency-cruiser: the rules are a few
// sentences long, the only dependency is the TypeScript compiler the repo already has, and agents
// can read it in a few screens. If the rule set grows past what fits here, switch to
// dependency-cruiser.
//
// Imports are read with TypeScript's own pre-processor (`ts.preProcessFile`), not a regex, so
// static imports, `export … from`, `import('x')` and `require('x')` all count, and an import
// inside a comment or a string does not (TODO #20c decision 7). Svelte files are read per
// `<script>` block. A specifier that is not a string literal (`import(name)`) cannot be checked.
//
// Rules:
//   1. packages/core imports no other workspace and none of the I/O libraries listed below.
//   2. Adapters and fronts may import packages/core; they may not import each other.
//      (apps/web and packages/mcp may import packages/api only through API_ENTRIES: its
//      composition root `@mycel/api/compose`, which wires adapters into the core, and the
//      If-None-Match rule `@mycel/api/conditional`, which every front answering a 304 shares; see
//      ALLOWED.) The fronts may
//      import packages/observability (logs, context, metrics), which imports only the core.
//      A relative import never leaves its own workspace (`../../core/src/x` is a violation:
//      cross-workspace imports go through the package name).
//   3. Every workspace package.json declares license AGPL-3.0-only, and every installed
//      production dependency has a licence the allow-list accepts, read as an SPDX expression:
//      `A OR B` needs one of the two, `A AND B` needs both, `A WITH exception` counts as A.
//
// `--root <dir>` checks another tree; scripts/fixtures/dependency-rules/ holds one small repo
// per rule that must fail, and check-dependency-rules.test.mjs runs them.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import {
  ROOT,
  installedPackages,
  readJson,
  walk,
  workspaces as listWorkspaces,
} from './lib/repo.mjs';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : ROOT;
const workspaces = listWorkspaces(root);

const pkgName = (ws) => readJson(`${ws}/package.json`, root).name;
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
  'node:dns',
  'node:fs',
  'node:http',
  'node:net',
  'node:child_process',
  'undici',
  'nodemailer',
  '@mollie/',
  'sharp',
  '@aws-sdk/',
];
/** The only entries of packages/api that apps/web and packages/mcp may import (rule 2). */
const API_ENTRIES = ['@mycel/api/compose', '@mycel/api/conditional'];

const ALLOWED = {
  'apps/web': ['packages/core', 'packages/api', 'packages/observability'],
  'packages/api': [
    'packages/core',
    'packages/observability',
    'packages/db',
    'packages/mail-tem',
    'packages/blob',
    'packages/media-sharp',
    'packages/assist-openai',
  ],
  'packages/mcp': ['packages/core', 'packages/api', 'packages/observability'],
  'packages/observability': ['packages/core'],
  'packages/db': ['packages/core'],
  'packages/mail-tem': ['packages/core'],
  'packages/blob': ['packages/core'],
  'packages/media-sharp': ['packages/core'],
  'packages/assist-openai': ['packages/core'],
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
  // libvips, as sharp's prebuilt `@img/sharp-libvips-*` (TODO #10): the same licence as LGPL-3.0
  // above, with the "or later" option, dynamically linked.
  'LGPL-3.0-or-later',
  'GPL-3.0',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'Python-2.0',
  // argparse 3 relabelled its Python-2.0 licence as PSF-2.0; same text, GPL-compatible per the FSF.
  'PSF-2.0',
]);

/**
 * Whether an SPDX licence expression is acceptable: AND binds tighter than OR, parentheses group,
 * `X WITH exception` is X. Anything that does not parse (`SEE LICENSE IN …`, `UNKNOWN`) is not.
 */
function licenceAllowed(expression, allowed = ALLOWED_LICENSES) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const fail = () => {
    throw new Error(`unparsable licence: ${expression}`);
  };
  const primary = () => {
    const token = tokens[i++];
    if (token === undefined || token === ')') fail();
    if (token === '(') {
      const value = or();
      if (tokens[i++] !== ')') fail();
      return value;
    }
    if (/^(AND|OR|WITH)$/.test(token)) fail();
    if (peek() === 'WITH') {
      i++;
      if (tokens[i++] === undefined) fail();
    }
    return allowed.has(token);
  };
  const and = () => {
    let value = primary();
    while (peek() === 'AND') {
      i++;
      value = primary() && value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === 'OR') {
      i++;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    return i === tokens.length && value;
  } catch {
    return false;
  }
}

const errors = [];

const sourceFiles = (dir) =>
  walk(relative(root, dir), { root, match: (p) => /\.(ts|js|mjs|cjs|svelte)$/.test(p) }).map((p) =>
    join(root, p)
  );

/** Every module specifier a file names: imports, re-exports, `import()` and `require()`. */
function specifiers(file) {
  const text = readFileSync(file, 'utf8');
  const code = file.endsWith('.svelte')
    ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    : text;
  return ts.preProcessFile(code, true, true).importedFiles.map((f) => f.fileName);
}

for (const ws of workspaces) {
  const srcDir = join(root, ws, 'src');
  if (!existsSync(srcDir)) continue;
  const allowed = ALLOWED[ws] ?? ['packages/core'];
  const home = join(root, ws) + sep;
  for (const file of sourceFiles(srcDir)) {
    const rel = relative(root, file);
    for (const spec of specifiers(file)) {
      if (spec.startsWith('.') && !resolve(dirname(file), spec).startsWith(home)) {
        errors.push(`${rel}: relative import ${spec} leaves ${ws} (use the package name)`);
        continue;
      }
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
        !API_ENTRIES.includes(spec)
      ) {
        errors.push(`${rel}: imports ${spec}; only ${API_ENTRIES.join(', ')} from ${ws}`);
      }
      if (ws === CORE && IO_LIBS.some((lib) => spec === lib || spec.startsWith(lib))) {
        errors.push(`${rel}: core imports I/O library ${spec} (ADR 001)`);
      }
    }
  }
}

for (const ws of workspaces) {
  const pkg = readJson(`${ws}/package.json`, root);
  if (pkg.license !== 'AGPL-3.0-only')
    errors.push(`${ws}/package.json: license must be AGPL-3.0-only (ADR 006)`);
}

// Licence check over installed production dependencies (skipped when node_modules is absent).
const nm = join(root, 'node_modules');
if (existsSync(nm)) {
  const rootPkg = readJson('package.json', root);
  const devOnly = new Set(Object.keys(rootPkg.devDependencies ?? {}));
  for (const ws of workspaces) {
    const pkg = readJson(`${ws}/package.json`, root);
    for (const d of Object.keys(pkg.devDependencies ?? {})) devOnly.add(d);
  }
  for (const pj of installedPackages(root)) {
    const pkg = readJson(pj, root);
    const lic =
      typeof pkg.license === 'string'
        ? pkg.license
        : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? 'UNKNOWN');
    if (!licenceAllowed(lic) && !devOnly.has(pkg.name))
      errors.push(
        `dependency ${pkg.name}@${pkg.version}: licence ${lic} not in allow-list (ADR 006)`
      );
  }
}

if (errors.length) {
  console.error('Dependency rules violated:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`dependency rules ok (${workspaces.length} workspaces)`);
