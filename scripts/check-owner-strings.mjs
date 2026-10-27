// Fails when a tracked file carries the owner's private process into this public repository: a
// personal home path, the private planning sibling, the owner's agent tooling (`model-mode`,
// `shared-task`) or a planning lane (`mbp`, `dev`) as a code identifier. Mycel has to build, test
// and run for anyone who clones it; how the owner steers agents belongs in the private sibling.
// Paths that still violate today are listed in owner-strings.allowlist.json, which may only shrink:
// an entry without a violation fails too, so a cleaned file leaves the list in the same change.
// Run by `npm run lint:infra`; fixtures in scripts/fixtures/owner-strings/ prove each rule.
// Rejected: a reviewer checklist item (it never caught the home path that reached a test) and a
// gitleaks rule (gitleaks scans for secrets; these strings are not secret, only out of place).

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Patterns that are wrong in any tracked text file. */
const anywhere = [
  { rule: 'personal home path', pattern: /\/Users\/|\/home\/jstronks\b/ },
  { rule: 'private planning sibling', pattern: /mycel-planning/ },
  { rule: 'owner agent tooling', pattern: /\bmodel-mode\b|\bshared-task\b/ },
];

/** Lane names as identifiers in code. `'dev'` alone is also an npm script name, so only flag it
 * where it names an owner or a lane; `'mbp'` has no other meaning. */
const code = /\.(m?[jt]s|svelte)$/;
const inCode = [
  { rule: 'planning lane literal', pattern: /(['"`])mbp\1/ },
  { rule: 'planning lane literal', pattern: /\b(owner|lane)\b[^\n]{0,24}(['"`])dev\2/ },
];

/** Files that may name the private sibling, with the reason. */
const excluded = new Map([
  ['CLAUDE.md', 'agent instructions explain the docs/plans symlink to the private sibling'],
  ['.gitignore', 'ignores the docs/plans symlink and says what it points at'],
  ['docs/README.md', 'tells a contributor how to recreate the docs/plans symlink'],
  ['scripts/check-owner-strings.mjs', 'the gate names the strings it rejects'],
  ['scripts/check-owner-strings.test.mjs', 'the fixture names name the rules they break'],
  ['scripts/owner-strings.allowlist.json', 'the burndown list names the violating paths'],
]);
const excludedDirs = ['scripts/fixtures/owner-strings/', 'docs/plans/', 'node_modules/'];

const ALLOWLIST = 'scripts/owner-strings.allowlist.json';

function walk(root, dir = root) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isDirectory()) return walk(root, full);
    return stat.isFile() ? [relative(root, full)] : [];
  });
}

/** Tracked files for the repository itself; every file for a fixture directory, which is not a
 * repository of its own. Symlinks are skipped: their target is checked where it lives. */
function files(root) {
  let top = '';
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  } catch {
    // Not a checkout: walk the directory.
  }
  if (resolve(top.trim()) !== resolve(root)) return walk(root);
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => {
      if (!path) return false;
      try {
        return lstatSync(join(root, path)).isFile();
      } catch {
        return false; // Deleted in the working tree but not yet staged.
      }
    });
}

export function check(root) {
  const allowlistPath = join(root, ALLOWLIST);
  const allowed = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8')).paths
    : [];
  const violations = new Map();
  for (const path of files(root)) {
    if (excluded.has(path) || excludedDirs.some((dir) => path.startsWith(dir))) continue;
    const buffer = readFileSync(join(root, path));
    if (buffer.includes(0)) continue; // Binary.
    const rules = code.test(path) ? [...anywhere, ...inCode] : anywhere;
    buffer
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const { rule, pattern } of rules)
          if (pattern.test(line)) {
            const list = violations.get(path) ?? new Set();
            list.add(`${path}:${index + 1}: ${rule}`);
            violations.set(path, list);
          }
      });
  }
  const errors = [];
  for (const [path, list] of violations) if (!allowed.includes(path)) errors.push(...list);
  for (const path of allowed)
    if (!violations.has(path))
      errors.push(`${ALLOWLIST}: ${path} has no violation any more; remove the entry`);
  const tolerated = allowed.filter((path) => violations.has(path)).length;
  return { errors, tolerated };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--root');
  const root =
    flag > 0 ? resolve(process.argv[flag + 1]) : fileURLToPath(new URL('..', import.meta.url));
  const { errors, tolerated } = check(root);
  if (errors.length) {
    console.error(`owner strings: ${errors.length} problem(s)`);
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`owner strings ok (${tolerated} allowlisted paths still to clean)`);
}
