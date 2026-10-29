// What every gate under scripts/ does before it checks anything (TODO #75): find the repository
// root, list the files to read, read JSON, tell a test from source, strip comments, and refuse an
// allowance nothing needs any more. Each gate used to carry its own copy, in three walker styles
// with five skip lists, so the same tree was not the same tree to two gates.
// `scripts/lib/repo.test.mjs` keeps every gate on this module.
// Rejected: a dependency (globby, fast-glob) for what `readdirSync` does, and one module per
// helper (four files that always travel together).

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, absolute, without a trailing slash. */
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Directories no gate reads: installed packages, build output, VCS and per-user state. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', '.git']);

/**
 * The files under `dir` (relative to `root`, `''` for the root) that `match` accepts, as
 * root-relative POSIX paths, sorted. Does not enter `SKIP_DIRS` or a directory `skip` accepts,
 * and skips symlinks (their target is read where it lives). A missing `dir` gives `[]`.
 */
export function walk(dir, { root = ROOT, match = () => true, skip = () => false } = {}) {
  const out = [];
  const visit = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? posix.join(rel, name) : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !skip(path)) visit(path);
      } else if (stat.isFile() && match(path)) out.push(path);
    }
  };
  if (existsSync(join(root, dir))) visit(dir);
  return out;
}

/** `[{ path, text }]` for root-relative `paths`. */
export const readAll = (paths, root = ROOT) =>
  paths.map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

/**
 * The tracked regular files of the checkout at `root`, or `null` when `root` is not the top of a
 * checkout (a fixture directory). Files deleted in the working tree are left out.
 */
export function gitFiles(root = ROOT) {
  let top = '';
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
  if (resolve(top.trim()) !== resolve(root)) return null;
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => {
      if (!path) return false;
      try {
        return lstatSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    });
}

/** The parsed JSON at `path`, relative to `root` or absolute. */
export const readJson = (path, root = ROOT) =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8'));

/** The workspaces (`packages/<name>`, `apps/<name>`) that have a package.json, relative to `root`. */
export const workspaces = (root = ROOT) =>
  ['packages', 'apps']
    .flatMap((top) =>
      existsSync(join(root, top)) ? readdirSync(join(root, top)).map((n) => `${top}/${n}`) : []
    )
    .filter((ws) => existsSync(join(root, ws, 'package.json')))
    .sort();

/**
 * The package.json paths of the packages installed in `root`/node_modules, scoped ones included,
 * nested installs and linked workspaces left out (the workspaces are checked as workspaces).
 */
export const installedPackages = (root = ROOT) =>
  walk('node_modules', {
    root,
    match: (p) => /^node_modules\/(@[^/]+\/)?[^/.][^/]*\/package\.json$/.test(p),
    skip: (p) => {
      const parts = p.split('/');
      return parts.length > 3 || (parts.length === 3 && !parts[1].startsWith('@'));
    },
  });

/** A test or spec file, which the code rules of a gate do not apply to. */
export const isTest = (path) => /\.(test|spec)\.[cm]?[jt]s$/.test(path);

/**
 * `text` with block and line comments blanked, line numbers kept. A `//` after a colon is a URL,
 * not a comment.
 */
export const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

/**
 * One message per entry of `allowed` that `stillNeeded(entry)` no longer justifies, so an
 * allowance shrinks in the change that makes it unnecessary.
 */
export const staleEntries = (allowed, stillNeeded, where) =>
  [...allowed]
    .filter((entry) => !stillNeeded(entry))
    .map((entry) => `${where}: ${entry} is no longer needed; remove the entry`);
