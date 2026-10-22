// Every relative link in the Markdown of the repository root and docs/ points at a file that
// exists and, with a #fragment, at a heading in it (TODO #18a). docs/plans is a gitignored symlink
// to the private planning repo, absent in CI, so it is neither scanned nor a valid target. Run by
// `npm run lint:infra` through `node --test`, offline like the rest of `verify`.
// Rejected: an external link checker (a dependency, and network in the gate); external URLs are
// not checked here at all.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const plans = join(root, 'docs/plans');

function* markdown(dir, deep) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full === plans || entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(full).isDirectory()) {
      if (deep) yield* markdown(full, deep);
    } else if (entry.endsWith('.md')) yield full;
  }
}

/** The text outside fenced code blocks and inline code, where a link is a link. */
const prose = (text) => text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats -1, -2. */
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const m of text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1]
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Every broken relative link of one Markdown file, as `file: target (reason)`. */
export function brokenLinks(file, text = readFileSync(file, 'utf8')) {
  const broken = [];
  for (const m of prose(text).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
    const [path, fragment] = target.split('#');
    const resolved = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const where = `${relative(root, file)}: ${target}`;
    if (resolved === plans || resolved.startsWith(plans + '/')) {
      broken.push(`${where} (docs/plans is private and absent in CI)`);
      continue;
    }
    if (!existsSync(resolved)) {
      broken.push(`${where} (no such file)`);
      continue;
    }
    if (
      fragment &&
      resolved.endsWith('.md') &&
      !anchors(readFileSync(resolved, 'utf8')).has(fragment)
    )
      broken.push(`${where} (no such heading)`);
  }
  return broken;
}

test('every relative link in the docs resolves', () => {
  const files = [...markdown(root, false), ...markdown(join(root, 'docs'), true)];
  assert.ok(files.length > 10, 'found the Markdown files');
  assert.deepEqual(
    files.flatMap((f) => brokenLinks(f)),
    []
  );
});

test('a missing file, a missing heading and a link into docs/plans fail', () => {
  const file = join(root, 'docs/README.md');
  const text = [
    '[ok](self-hosting.md#install)',
    '[gone](no-such-file.md)',
    '[heading](self-hosting.md#no-such-heading)',
    '[private](plans/TODO.md)',
    '[external](https://example.org/x.md)',
    '`[code](not-a-link.md)`',
  ].join('\n');
  assert.deepEqual(brokenLinks(file, text), [
    'docs/README.md: no-such-file.md (no such file)',
    'docs/README.md: self-hosting.md#no-such-heading (no such heading)',
    'docs/README.md: plans/TODO.md (docs/plans is private and absent in CI)',
  ]);
});

test('anchors follow GitHub, duplicates included', () => {
  assert.deepEqual(
    [...anchors('# Self-hosting Mycel\n## What runs, and with which credentials\n## A\n## A\n')],
    ['self-hosting-mycel', 'what-runs-and-with-which-credentials', 'a', 'a-1']
  );
});
