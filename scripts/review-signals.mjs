#!/usr/bin/env node
// The deterministic half of a targeted review (docs/architecture/review.md): maps the files a
// pull request changes through docs/architecture/review-profile.json and prints which review
// lenses the diff touches, which gates already cover them, and which flags the reviewer reads
// first. It chooses nothing. The reviewer (a person or a model) picks at most one extra
// counterproof from what it prints, and records that choice; the judgement stays theirs, the
// bookkeeping is here so it costs no model tokens and comes out the same every run.
//
// Rejected: letting the model derive this from the diff each time (expensive, and different
// every run), and a numeric risk score (false precision; a path list cannot see chains such as a
// cache change that breaks a form post, which is exactly what the lens question is for).
//
// A file that matches no lens, no flag and no informational pattern is `unmapped`: the verdict
// is then `needs review`, never a silent pass. Offline and git-only: CI status is the reviewer's
// to check on the same SHA, and this script says so instead of guessing.
//
//   node scripts/review-signals.mjs                      # origin/main...HEAD
//   node scripts/review-signals.mjs --base main --head feat/x
//   node scripts/review-signals.mjs --files a.ts b.ts    # no git, for tests and PR bodies
//   node scripts/review-signals.mjs --json

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const PROFILE = new URL('../docs/architecture/review-profile.json', import.meta.url);

/** A path pattern to a RegExp: `**` crosses directories, `*` and `?` stay within one. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` may also match nothing, so `**/*.spec.ts` matches `a.spec.ts` at the root.
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matches = (file, patterns) => patterns.some((p) => globToRegExp(p).test(file));

export function loadProfile(url = PROFILE) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * Routes a list of changed files through the profile. Pure: same input, same output.
 * Lenses come back mandatory first, then by how many files they touch; a lens no file touches
 * is left out. `unmapped` holds files the profile does not know; `informational` the ones that
 * change no behaviour.
 */
export function route(files, profile) {
  const sorted = [...new Set(files)].sort();
  const lenses = profile.lenses
    .map((lens) => ({
      id: lens.id,
      title: lens.title,
      status: lens.status,
      files: sorted.filter((f) => matches(f, lens.paths)),
      adrs: lens.adrs,
      gates: lens.gates,
      counterproof: lens.counterproof,
    }))
    .filter((l) => l.files.length > 0)
    .sort((a, b) => {
      const m = (l) => (l.status === 'mandatory' ? 0 : 1);
      return m(a) - m(b) || b.files.length - a.files.length || a.id.localeCompare(b.id);
    });
  const flags = profile.flags
    .map((flag) => ({
      id: flag.id,
      note: flag.note,
      files: sorted.filter((f) => matches(f, flag.paths)),
    }))
    .filter((f) => f.files.length > 0);
  const known = new Set([...lenses, ...flags].flatMap((x) => x.files));
  const informational = sorted.filter((f) => !known.has(f) && matches(f, profile.informational));
  const unmapped = sorted.filter((f) => !known.has(f) && !informational.includes(f));
  const verdict =
    unmapped.length > 0
      ? 'needs review'
      : lenses.length === 0 && flags.length === 0
        ? 'no behaviour change'
        : 'route';
  return { files: sorted.length, lenses, flags, informational, unmapped, verdict };
}

/** The Markdown block a reviewer pastes into the review record or a PR body. */
export function render(result, { base, head } = {}) {
  const lines = [];
  lines.push(`**Review signals** (${result.files} files${base ? `, \`${base}...${head}\`` : ''})`);
  lines.push(`Verdict: **${result.verdict}**. CI on this exact SHA: check it yourself.`);
  for (const lens of result.lenses) {
    lines.push('');
    lines.push(
      `- **${lens.title}** (\`${lens.id}\`, ${lens.status}): ${lens.files.length} file(s)`
    );
    lines.push(
      `  - ADR ${lens.adrs.join(', ')}; gates: ${lens.gates.map((g) => `\`${g}\``).join(', ')}`
    );
    lines.push(`  - Smallest counterproof: ${lens.counterproof}`);
  }
  for (const flag of result.flags) {
    lines.push('');
    lines.push(
      `- **Flag \`${flag.id}\`** (${flag.files.map((f) => `\`${f}\``).join(', ')}): ${flag.note}`
    );
  }
  if (result.unmapped.length) {
    lines.push('');
    lines.push(
      `- **Unmapped** (not in the profile; map or judge by hand): ${result.unmapped.map((f) => `\`${f}\``).join(', ')}`
    );
  }
  if (result.informational.length) {
    lines.push('');
    lines.push(`- Informational, no behaviour: ${result.informational.length} file(s)`);
  }
  return lines.join('\n') + '\n';
}

function changedFiles(base, head) {
  return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const json = args.includes('--json');
  const filesAt = args.indexOf('--files');
  const base = opt('--base', 'origin/main');
  const head = opt('--head', 'HEAD');
  const files =
    filesAt >= 0
      ? args.slice(filesAt + 1).filter((a) => !a.startsWith('--'))
      : changedFiles(base, head);
  const result = route(files, loadProfile());
  const range = filesAt >= 0 ? {} : { base, head };
  process.stdout.write(
    json ? JSON.stringify({ ...range, ...result }, null, 2) + '\n' : render(result, range)
  );
}
