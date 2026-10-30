// Fails when a tracked file carries the owner's private process into this public repository: a
// personal home path, the private planning sibling, the owner's agent tooling (`model-mode`,
// `shared-task`), a planning lane (`mbp`, `dev`) as a code identifier, or the words of the
// private planning (`mbp`, `lane`, `proef`) in prose, comments and workflows. Mycel has to build,
// test and run for anyone who clones it; how the owner steers agents belongs in the private
// sibling. The review method's `pilot` lens status is public vocabulary (review.md) and stays.
// Paths that still violate today are listed in owner-strings.allowlist.json, which may only shrink:
// an entry without a violation fails too, so a cleaned file leaves the list in the same change.
// Run by `npm run lint:infra`; fixtures in scripts/fixtures/owner-strings/ prove each rule.
// Rejected: a reviewer checklist item (it never caught the home path that reached a test) and a
// gitleaks rule (gitleaks scans for secrets; these strings are not secret, only out of place).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, gitFiles, readJson, walk } from './lib/repo.mjs';

/**
 * Patterns that are wrong in any tracked text file. A home directory is personal unless it is a
 * CI runner's or a container user's.
 */
const anywhere = [
  {
    rule: 'personal home path',
    pattern: /\/Users\/[\w.-]|\/home\/(?!runner\b|node\b)[a-z][\w.-]*/,
  },
  { rule: 'private planning sibling', pattern: /mycel-planning/ },
  { rule: 'owner agent tooling', pattern: /\bmodel-mode\b|\bshared-task\b/ },
];

/** Prose, comments, code and workflows: everything a reader reads, but not data (JSON keeps
 * `mbp` as a value a fixture or a test may hold). `mbp` has no other meaning. */
const text = /\.(md|ya?ml|m?[jt]s|svelte)$/;
const inText = [
  { rule: 'planning lane word', pattern: /\bmbp\b|\blanes?\b/i },
  { rule: 'private trial reference', pattern: /\bproef\s+\d/i },
];

/** `'dev'` alone is also an npm script name, so in code it is flagged only where it names an
 * owner (a lane is already a planning word). */
const code = /\.(m?[jt]s|svelte)$/;
const inCode = [{ rule: 'planning lane literal', pattern: /\bowner\b[^\n]{0,24}(['"`])dev\1/ }];

/** Provenance in a comment is history git already holds; the comment says the constraint. ADR
 * amendments name their review on purpose, so Markdown is left out. */
const source = /\.(m?[jt]s|svelte|sh|sql)$/;
const inSource = [
  {
    rule: 'provenance comment',
    pattern: /\breview of PR\b|\bmoved here from\b|\btook over from\b/i,
  },
];

/** Files the rules do not apply to, with the reason. */
const excluded = new Map([
  ['CLAUDE.md', 'agent instructions explain the docs/plans symlink to the private sibling'],
  ['CHANGELOG.md', 'released entries are history; a squash title is not rewritten afterwards'],
  ['.gitignore', 'ignores the docs/plans symlink and says what it points at'],
  ['docs/README.md', 'tells a contributor how to recreate the docs/plans symlink'],
  ['scripts/check-owner-strings.mjs', 'the gate names the strings it rejects'],
  ['scripts/check-owner-strings.test.mjs', 'the fixture names name the rules they break'],
  ['scripts/owner-strings.allowlist.json', 'the burndown list names the violating paths'],
]);
const excludedDirs = ['scripts/fixtures/owner-strings/', 'docs/plans/', 'node_modules/'];

const ALLOWLIST = 'scripts/owner-strings.allowlist.json';

/** Tracked files for the repository itself; every file for a fixture directory, which is not a
 * repository of its own. Symlinks are skipped: their target is checked where it lives. */
const files = (root) => gitFiles(root) ?? walk('', { root });

export function check(root) {
  const allowlistPath = join(root, ALLOWLIST);
  const allowed = existsSync(allowlistPath) ? readJson(allowlistPath).paths : [];
  const violations = new Map();
  for (const path of files(root)) {
    if (excluded.has(path) || excludedDirs.some((dir) => path.startsWith(dir))) continue;
    const buffer = readFileSync(join(root, path));
    if (buffer.includes(0)) continue; // Binary.
    const rules = [
      ...anywhere,
      ...(text.test(path) ? inText : []),
      ...(code.test(path) ? inCode : []),
      ...(source.test(path) ? inSource : []),
    ];
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
  const root = flag > 0 ? resolve(process.argv[flag + 1]) : ROOT;
  const { errors, tolerated } = check(root);
  if (errors.length) {
    console.error(`owner strings: ${errors.length} problem(s)`);
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`owner strings ok (${tolerated} allowlisted paths still to clean)`);
}
