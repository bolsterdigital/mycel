#!/usr/bin/env node
// Finds exports nothing uses (TODO #53 PR 6). An export is dead when no other file in the repo
// imports it, directly or through a re-export, and its own file does not use it either. Run by
// `scripts/dead-exports.test.mjs` in `npm run lint:infra` against a baseline, so the count can
// only go down: a new dead export is red, and so is a baseline line that is no longer dead.
//
// Why a script and not knip or ts-prune: the same reason as check-dependency-rules.mjs. The only
// dependency is the TypeScript compiler the repo already has, the rules fit on a few screens, and
// ts-prune is unmaintained. If the resolution rules below stop fitting (path aliases, `export *`,
// framework entry points beyond SvelteKit's), switch to knip rather than growing this file.
//
// What it reads: every `.ts` under packages/*/src and apps/web/{src,e2e}, the `<script>` blocks of
// every `.svelte` file, and scripts/**/*.mjs. Tests, e2e specs and scripts count as users, so an
// export only a test needs is alive. Checked are the non-test `.ts` files under packages/*/src and
// apps/web/src/lib; SvelteKit routes, hooks and params are entry points the framework reads.
// Specifiers resolve relative (`./x.js` to `./x.ts`) and through a workspace's package.json
// `exports` (`@mycel/core/testing` to packages/core/src/testing/index.ts) or `imports` (`#lib/*`
// in apps/web); anything else is a
// third-party module and ignored. `export * from` passes a name through to the module that
// declares it, which is where a dead one is reported; `import * as` and `import()` of a workspace
// module keep all of its exports alive, unless the dynamic import is destructured or read as
// `(await import(x)).name`.
//
// Used in its own file counts as alive: dropping only the `export` keyword can break declaration
// emit (a public signature naming an unexported type), and the dead code this hunts is code no
// one calls. Rejected: also reporting "exported but only used locally" (knip's default), which
// would mostly ask for keyword churn.

import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ROOT as root, isTest, readAll, readJson, walk, workspaces } from './lib/repo.mjs';

export const BASELINE = 'scripts/dead-exports.baseline.json';

/** Whether `path` is a file whose exports are checked. */
export const checked = (path) =>
  path.endsWith('.ts') &&
  !isTest(path) &&
  !path.endsWith('.d.ts') &&
  !path.includes('/fixtures/') &&
  (/^packages\/[^/]+\/src\//.test(path) || path.startsWith('apps/web/src/lib/'));

/** Every source file that can use or export something, as `{ path: text }`. */
export function readSources(root) {
  const dirs = [
    ...workspaces(root)
      .filter((ws) => ws.startsWith('packages/'))
      .map((ws) => `${ws}/src`),
    'apps/web/src',
    'apps/web/e2e',
  ];
  const paths = [
    ...dirs.flatMap((d) => walk(d, { root, match: (p) => /\.(ts|svelte)$/.test(p) })),
    ...walk('scripts', { root, match: (p) => p.endsWith('.mjs') && !p.includes('/fixtures/') }),
  ];
  return Object.fromEntries(readAll(paths, root).map(({ path, text }) => [path, text]));
}

/** `{ '@mycel/core/testing': 'packages/core/src/testing/index.ts', … }` from package.json. */
export function readPackages(root) {
  const map = {};
  for (const ws of workspaces(root)) {
    const { name, exports, imports } = readJson(`${ws}/package.json`, root);
    for (const [sub, target] of Object.entries(exports ?? {})) {
      const types = typeof target === 'string' ? target : (target.types ?? target.default);
      const src = types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts');
      map[posix.join(name, sub)] = posix.join(ws, src);
    }
    // Subpath imports (`#lib/*` in apps/web) are private to the workspace; the key carries it.
    for (const [key, target] of Object.entries(imports ?? {}))
      map[`${ws}:${key}`] = posix.join(ws, target);
  }
  return map;
}

/** The workspace file `spec` names from `from`, or null for a third-party module. */
function resolver(files, packages) {
  return (from, spec) => {
    if (spec in packages) return packages[spec];
    if (spec.startsWith('#')) return local(subpath(from, spec));
    if (!spec.startsWith('.')) return null;
    return local(posix.normalize(posix.join(posix.dirname(from), spec)));
  };
  /** `apps/web/src/lib/x.js` for `#lib/x.js` from a file in apps/web, by its `imports` map. */
  function subpath(from, spec) {
    const ws = from.split('/').slice(0, 2).join('/');
    if (`${ws}:${spec}` in packages) return packages[`${ws}:${spec}`];
    for (const [key, target] of Object.entries(packages)) {
      const [owner, pattern] = key.split(':');
      if (owner !== ws || !pattern?.endsWith('/*') || !spec.startsWith(pattern.slice(0, -1)))
        continue;
      return target.replace(/\*$/, spec.slice(pattern.length - 1));
    }
    return null;
  }
  function local(base) {
    if (base === null) return null;
    const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`];
    return candidates.find((c) => c in files) ?? null;
  }
}

const scriptOf = (path, text) =>
  path.endsWith('.svelte')
    ? [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
    : text;

/** Identifiers a binding pattern declares. */
function bound(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bound(e.name)));
}

const exported = (node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const defaulted = (node) =>
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** What one file exports, re-exports and imports. */
function scan(path, text, resolve) {
  const file = ts.createSourceFile(path, scriptOf(path, text), ts.ScriptTarget.Latest, true);
  const locals = new Map(); // exported name -> local name
  const reexports = []; // { name, target, orig }
  const stars = []; // targets of `export * from`
  const uses = []; // { target, name } ; name '*' = all
  const declared = new Set(); // name nodes of exported declarations
  const use = (spec, name) => {
    const target = resolve(path, spec);
    if (target) uses.push({ target, name });
  };
  for (const st of file.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.name) use(spec, 'default');
      const b = clause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) use(spec, '*');
      if (b && ts.isNamedImports(b))
        for (const e of b.elements) use(spec, (e.propertyName ?? e.name).text);
    } else if (ts.isExportDeclaration(st)) {
      const clause = st.exportClause;
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolve(path, st.moduleSpecifier.text);
        if (!clause) {
          if (target) stars.push(target);
        } else if (ts.isNamespaceExport(clause)) use(st.moduleSpecifier.text, '*');
        else if (target)
          for (const e of clause.elements)
            reexports.push({ name: e.name.text, target, orig: (e.propertyName ?? e.name).text });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const e of clause.elements) locals.set(e.name.text, (e.propertyName ?? e.name).text);
      }
    } else if (ts.isExportAssignment(st)) {
      locals.set('default', null);
    } else if (exported(st)) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations)
          for (const n of bound(d.name)) locals.set(n, n);
        st.declarationList.declarations.forEach((d) => declared.add(d.name));
      } else if (st.name) {
        locals.set(defaulted(st) ? 'default' : st.name.text, st.name.text);
        declared.add(st.name);
      }
    }
  }
  const counts = new Map();
  const visit = (node) => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const lit = node.argument.literal;
      const q = node.qualifier;
      const first = q && (ts.isIdentifier(q) ? q : q.left);
      if (ts.isStringLiteral(lit))
        use(lit.text, first && ts.isIdentifier(first) ? first.text : '*');
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      for (const name of dynamicNames(node)) use(node.arguments[0].text, name);
    } else if (ts.isIdentifier(node) && !declared.has(node) && !isMemberName(node)) {
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const usedHere = (local) =>
    local !== null && (counts.get(local) ?? 0) > (exportSpecified(file, local) ? 1 : 0);
  return { locals, reexports, stars, uses, usedHere };
}

/** The names `const { a, b } = await import(x)` or `(await import(x)).a` take; else all. */
function dynamicNames(call) {
  let node = call.parent;
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.parent;
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name))
    return node.name.elements.map((e) =>
      e.propertyName && ts.isIdentifier(e.propertyName)
        ? e.propertyName.text
        : ts.isIdentifier(e.name)
          ? e.name.text
          : '*'
    );
  if (ts.isPropertyAccessExpression(node)) return [node.name.text];
  return ['*'];
}

/** A property or member name, which is not a use of a binding with the same text. */
function isMemberName(node) {
  const p = node.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === node) ||
    ((ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isEnumMember(p)) &&
      p.name === node) ||
    (ts.isQualifiedName(p) && p.right === node) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    (ts.isExportSpecifier(p) && p.parent.parent.moduleSpecifier !== undefined)
  );
}

/** Whether `export { local }` names it, which the identifier count then saw once. */
const exportSpecified = (file, local) =>
  file.statements.some(
    (st) =>
      ts.isExportDeclaration(st) &&
      !st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause) &&
      st.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === local)
  );

/**
 * Dead exports in `files` (`{ path: text }`) as sorted `path#name` strings. `packages` maps a
 * workspace specifier to its source entry, as `readPackages` returns it.
 */
export function deadExports(files, packages = {}) {
  const resolve = resolver(files, packages);
  const scans = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, scan(path, text, resolve)])
  );
  const names = new Map();
  /** Every name `path` exports, including what its `export *` targets export. */
  const exportsOf = (path) => {
    if (names.has(path)) return names.get(path);
    const s = scans[path];
    const all = new Set(s ? [...s.locals.keys(), ...s.reexports.map((r) => r.name)] : []);
    names.set(path, all);
    for (const t of s?.stars ?? []) for (const n of exportsOf(t)) if (n !== 'default') all.add(n);
    return all;
  };
  const used = new Set();
  const mark = (path, name) => {
    const s = scans[path];
    if (!s) return;
    if (name === '*') {
      for (const n of exportsOf(path)) mark(path, n);
      return;
    }
    if (used.has(`${path}#${name}`)) return;
    used.add(`${path}#${name}`);
    for (const r of s.reexports) if (r.name === name) mark(r.target, r.orig);
    if (!s.locals.has(name) && !s.reexports.some((r) => r.name === name))
      for (const t of s.stars) if (exportsOf(t).has(name)) mark(t, name);
  };
  for (const s of Object.values(scans)) for (const u of s.uses) mark(u.target, u.name);
  const dead = [];
  for (const [path, s] of Object.entries(scans)) {
    if (!checked(path)) continue;
    for (const [name, local] of s.locals)
      if (!used.has(`${path}#${name}`) && !s.usedHere(local)) dead.push(`${path}#${name}`);
    for (const r of s.reexports) if (!used.has(`${path}#${r.name}`)) dead.push(`${path}#${r.name}`);
  }
  return dead.sort();
}

export const currentDead = () => deadExports(readSources(root), readPackages(root));
export const readBaseline = () => readJson(BASELINE);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dead = currentDead();
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(join(root, BASELINE), `${JSON.stringify(dead, null, 2)}\n`);
    console.log(`${dead.length} dead exports written to ${BASELINE}`);
  } else {
    for (const d of dead) console.log(d);
    console.log(`${dead.length} dead exports`);
  }
}
