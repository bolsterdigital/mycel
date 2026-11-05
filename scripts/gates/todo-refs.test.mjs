// References to the private planning board (`TODO #n`, or a bare `#n` in a comment) in packages/,
// apps/, scripts/, docker/ and .github/ only go down: each file against
// scripts/gates/todo-refs.baseline.json, and docs/adr, docs/architecture and the README hold none. A reader of this public repository cannot follow such a number; the constraint belongs in
// the comment and the history in git. Run by `npm run lint:infra`, offline.
// Rejected: one total (a removed reference and a new one elsewhere cancel out silently), and
// rewriting all of them at once (the replacement waits on a maintainer decision).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFiles, ratchet, readJson, ROOT } from '../lib/repo.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE = 'scripts/gates/todo-refs.baseline.json';
const REF = /TODO #\d/g;
/** A bare `#n`. `PR #n` is a public number a reader can follow, and `&#n;` is an entity. */
const NUMBER = /(?<![\w&/#-])(?<!PRs? )(?<!TODO )#\d{1,3}\b/;
/** The same number after a comment marker on its line, so a colour or an anchor does not count. */
const BARE = new RegExp(String.raw`(?:^\s*(?:\*|#)|\/\/|\/\*|<!--|\s#\s).*?` + NUMBER.source);

/**
 * The comment forms that run over lines, per kind of file. Only there: `/*` in a YAML path or a
 * shell glob opens nothing. An opener after a path or a quote is a glob as well (`packages/*`).
 */
const blockComments = (path) => [
  ...(/\.(?:[cm]?[jt]s|css|svelte)$/.test(path) ? [[/(?<![\w*'"`/.-])\/\*/, '*/']] : []),
  ...(/\.(?:svelte|html)$/.test(path) ? [[/<!--/, '-->']] : []),
];

/** The lines with a bare number: after a marker, or anywhere inside an open block comment. */
function bareRefs(text, path) {
  const forms = blockComments(path);
  let close = null;
  let n = 0;
  for (const line of text.split('\n')) {
    let hit = BARE.test(line) && close === null;
    let rest = line;
    while (rest) {
      if (close !== null) {
        const end = rest.indexOf(close);
        if (NUMBER.test(end < 0 ? rest : rest.slice(0, end))) hit = true;
        if (end < 0) break;
        rest = rest.slice(end + close.length);
        close = null;
      } else {
        const open = forms
          .map(([opener, closer]) => ({ match: rest.match(opener), closer }))
          .filter(({ match }) => match)
          .sort((a, b) => a.match.index - b.match.index)[0];
        if (!open) break;
        rest = rest.slice(open.match.index + open.match[0].length);
        close = open.closer;
      }
    }
    if (hit) n++;
  }
  return n;
}

/**
 * `{ path: count }` of every text file in `paths` with at least one reference. A NUL byte is how
 * git itself tells a binary: a font or a photo holds `#1` by chance, and no reader sees it.
 */
export function countRefs(paths, read) {
  const counts = {};
  for (const p of paths) {
    const text = read(p);
    if (text.includes('\0')) continue;
    const n = (text.match(REF) ?? []).length + bareRefs(text, p);
    if (n) counts[p] = n;
  }
  return counts;
}

const tracked = gitFiles() ?? [];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('references to the private board in code, scripts and workflows only go down', () => {
  const paths = tracked.filter((p) => /^(packages|apps|scripts|docker|\.github)\//.test(p));
  assert.ok(paths.length > 100, 'found the sources');
  const { grew, shrank, stale } = ratchet(
    countRefs(paths, read),
    { ceilings: readJson(BASELINE) },
    0
  );
  assert.deepEqual(grew, [], 'name the constraint instead of a private TODO number');
  assert.deepEqual(shrank, [], `fewer references: lower these entries in ${BASELINE}`);
  assert.deepEqual(stale, [], `no references left: remove these entries from ${BASELINE}`);
});

test('ADRs, architecture docs and the README reference no private board item', () => {
  const paths = tracked.filter(
    (p) => /^docs\/(adr|architecture)\/.*\.md$/.test(p) || p === 'README.md'
  );
  // Prose has no comment marker to go by, so a bare number there is left to review.
  assert.deepEqual(
    paths.filter((p) => read(p).match(REF)),
    []
  );
});

test('a bare number counts in a comment, not as a public PR, a colour or an entity', () => {
  const count = (text) => countRefs(['a.ts'], () => text)['a.ts'] ?? 0;
  assert.equal(count('// the menu (#87) collapses'), 1);
  assert.equal(count('  * #51: a refusal is a code'), 1);
  assert.equal(count('<!-- see #12 -->'), 1);
  assert.equal(count('# the worker (#34) drains'), 1);
  assert.equal(count('// PR #28 and PRs #175'), 0);
  assert.equal(count("const color = '#123';"), 0);
  assert.equal(count('<a href="#12">&#39;</a>'), 0);
});

test('a bare number on a later line of a block comment counts, and only inside it', () => {
  const count = (text, path = 'a.ts') => countRefs([path], () => text)[path] ?? 0;
  assert.equal(count('/*\n * see (#999)\n */\nconst a = 1;'), 1);
  assert.equal(count('/**\n  the menu (#87)\n  and (#88)\n*/'), 2);
  assert.equal(count('<!--\n  Page header (#999)\n-->', 'a.svelte'), 1);
  assert.equal(count('/* one */\n.a { color: #123; }', 'a.css'), 0);
  assert.equal(count('/*\n closed */ .a { color: #123; }', 'a.css'), 0);
  assert.equal(count('<!-- one -->\n<a href="x">#12</a>', 'a.svelte'), 0);
  assert.equal(count('/*\n PR #28\n*/'), 0);
  // Not a comment here: a glob in a string, a path in YAML, an HTML comment in TypeScript.
  assert.equal(count("const g = 'packages/*';\nconst c = '#123';\nconst d = 'x #12';"), 0);
  assert.equal(count('paths:\n  - /*\nname: (#12)', 'a.yml'), 0);
  assert.equal(count("const h = '<!--';\nconst d = 'x #12';"), 0);
});

test('a binary file holds no reference, whatever its bytes spell', () => {
  assert.deepEqual(
    countRefs(['font.ttf', 'a.ts'], (p) => (p === 'a.ts' ? '// (#1)' : '\0// (#1) TODO #2')),
    { 'a.ts': 1 }
  );
});

test('a new reference and a removed one are both reported', () => {
  const counts = countRefs(
    ['a.ts', 'b.ts', 'c.ts'],
    (p) => ({ 'a.ts': '// TODO #1 and TODO #2', 'b.ts': 'none', 'c.ts': '// TODO #3' })[p]
  );
  assert.deepEqual(counts, { 'a.ts': 2, 'c.ts': 1 });
  assert.deepEqual(ratchet(counts, { ceilings: { 'a.ts': 1, 'c.ts': 2, 'd.ts': 1 } }, 0), {
    grew: ['a.ts: 2 (ceiling 1)'],
    shrank: ['c.ts: 1 (ceiling 2)'],
    stale: ['d.ts: 0, within 0; remove the ceiling'],
  });
});
