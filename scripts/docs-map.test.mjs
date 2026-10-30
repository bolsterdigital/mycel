// The maps in docs/ describe what exists: the picture in docs/architecture/overview.md names every
// workspace package, every core module and only ports core exports; every reference page and
// architecture doc is reachable from overview.md or docs/README.md; docs/adr/README.md lists every
// ADR with the status its file states. Run by `npm run lint:infra` through `node --test`.
// Rejected: generating the overview picture from the code, because the picture is a reading aid
// with grouping and prose a generator would flatten; a check on what it names keeps it honest.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT as root, walk } from './lib/repo.mjs';

const read = (p) => readFileSync(join(root, p), 'utf8');
/** The names directly under `dir` that hold a file matching `match` somewhere below. */
const dirs = (dir, match = () => true) => [
  ...new Set(
    walk(dir, { match })
      .map((p) => p.slice(dir.length + 1).split('/'))
      .filter((parts) => parts.length > 1)
      .map((parts) => parts[0])
  ),
];

/** The Markdown files directly in `dir`, relative to it. */
const pagesIn = (dir) =>
  walk(dir, { match: (p) => p.endsWith('.md'), skip: (p) => p !== dir }).map((p) =>
    p.slice(dir.length + 1)
  );

/** The first fenced block of overview.md: the picture. */
export const picture = (text) => /^```\n([\s\S]*?)^```/m.exec(text)?.[1] ?? '';

/** Core module directories; `testing` and `util` are helpers, not modules. */
const coreModules = () =>
  dirs('packages/core/src', (p) => p.endsWith('.ts')).filter(
    (d) => d !== 'testing' && d !== 'util'
  );

/** What the picture gets wrong about packages, modules and ports, one line per finding. */
export function pictureFindings(text, { packages, modules, ports }) {
  const pic = picture(text);
  const findings = [];
  const named = new Set([...text.matchAll(/packages\/([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  for (const p of named)
    if (!packages.includes(p)) findings.push(`names packages/${p}, which does not exist`);
  for (const p of packages)
    if (!pic.includes(`packages/${p}`)) findings.push(`picture lacks packages/${p}`);
  for (const m of modules)
    if (!new RegExp(`\\b${m}\\b`).test(pic)) findings.push(`picture lacks core module ${m}`);
  const portLines = pic.slice(pic.indexOf('ports:')).split('\n');
  const end = portLines.findIndex((l) => l.includes('└'));
  const listed = portLines
    .slice(0, end < 0 ? undefined : end)
    .join(' ')
    .replace(/\(.*?\)/g, '')
    .match(/\b[A-Z][A-Za-z]+\b/g);
  for (const name of listed ?? [])
    if (!ports.has(name)) findings.push(`picture names port ${name}, which core does not export`);
  return findings;
}

/** Every `export interface X` in core's sources outside tests. */
const corePorts = () =>
  new Set(
    walk('packages/core/src', { match: (p) => p.endsWith('.ts') && !p.includes('.test.') })
      .flatMap((p) => [...read(p).matchAll(/^export interface (\w+)/gm)])
      .map((m) => m[1])
  );

test('the overview picture names what exists, and all of it', () => {
  assert.deepEqual(
    pictureFindings(read('docs/architecture/overview.md'), {
      packages: dirs('packages', (p) => /^packages\/[^/]+\/package\.json$/.test(p)),
      modules: coreModules(),
      ports: corePorts(),
    }),
    []
  );
});

test('a missing package, an invented package and an invented port are findings', () => {
  const text = [
    'see packages/payments for money',
    '```',
    '│ packages/core │ tenants',
    '│ ports: Clock, PaymentProvider (repositories) │',
    '└──┘',
    '```',
  ].join('\n');
  assert.deepEqual(
    pictureFindings(text, {
      packages: ['core', 'db'],
      modules: ['tenants', 'forms'],
      ports: new Set(['Clock']),
    }),
    [
      'names packages/payments, which does not exist',
      'picture lacks packages/db',
      'picture lacks core module forms',
      'picture names port PaymentProvider, which core does not export',
    ]
  );
});

/** Relative link targets of a Markdown text, without fragment. */
const links = (text) =>
  new Set([...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1].replace(/^\.\//, '')));

test('every reference page and architecture doc is linked from the maps', () => {
  const fromOverview = [...links(read('docs/architecture/overview.md'))]
    .filter((l) => l.startsWith('../reference/'))
    .map((l) => l.slice(3));
  const fromReadme = [...links(read('docs/README.md'))];
  const reachable = new Set([...fromOverview, ...fromReadme]);
  const pages = [
    ...pagesIn('docs/reference').map((f) => `reference/${f}`),
    ...pagesIn('docs/architecture').map((f) => `architecture/${f}`),
    ...pagesIn('docs').filter((f) => f !== 'README.md'),
  ];
  assert.ok(pages.length > 30, 'found the pages');
  assert.deepEqual(
    pages.filter((p) => !reachable.has(p)),
    []
  );
});

/** ADR files whose row in the index is missing or states another status. */
export function adrIndexFindings(index, adrs) {
  const rows = new Map(
    [...index.matchAll(/^\|[^|]*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => [
      m[1],
      m[2],
    ])
  );
  const findings = [];
  for (const [file, text] of adrs) {
    const status = /^- \*\*Status\*\*: (.+)$/m.exec(text)?.[1].trim();
    if (!rows.has(file)) findings.push(`${file} is not in the index`);
    else if (rows.get(file) !== status)
      findings.push(`${file}: index says ${rows.get(file)}, file says ${status}`);
  }
  return findings;
}

test('docs/adr/README.md lists every ADR with its status', () => {
  const adrs = pagesIn('docs/adr')
    .filter((f) => /^\d{3}-.*\.md$/.test(f))
    .map((f) => [f, read(`docs/adr/${f}`)]);
  assert.ok(adrs.length > 20, 'found the ADRs');
  assert.deepEqual(adrIndexFindings(read('docs/adr/README.md'), adrs), []);
});

test('a missing ADR and a stale status are findings', () => {
  const index = '| 001 | [One](001-one.md) | accepted |\n';
  assert.deepEqual(
    adrIndexFindings(index, [
      ['001-one.md', '- **Status**: superseded by ADR 002'],
      ['002-two.md', '- **Status**: accepted'],
    ]),
    [
      '001-one.md: index says accepted, file says superseded by ADR 002',
      '002-two.md is not in the index',
    ]
  );
});
