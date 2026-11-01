// Keeps spec-checklist.json complete and honest, and each spec-check rule able to fail. Every
// checklist item has exactly one status; a `gate` item names a rule that exists, a `covered` item
// names a file that exists, and an `open`, `declined` or `not-applicable` item says why. Run by
// `npm run lint:infra`, offline. Rejected: fetching the upstream checklist here (the test would
// change with a third-party release; a refresh is a deliberate edit of the JSON instead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { RULES, specFailures } from './spec-check.mjs';

const checklist = JSON.parse(readFileSync('scripts/quality/spec-checklist.json', 'utf8'));
const items = Object.entries(checklist.items);
const STATUSES = ['gate', 'covered', 'open', 'declined', 'not-applicable'];
const LEVELS = ['required', 'recommended', 'optional', 'avoid'];

test('the checklist holds all 178 items of the 2026-11-01 source', () => {
  assert.equal(items.length, 178);
  assert.equal(new Set(items.map(([, i]) => i.category)).size, 10);
});

test('every item has a level, a status and the reason that status needs', () => {
  for (const [slug, item] of items) {
    assert.ok(LEVELS.includes(item.level), `${slug}: level ${item.level}`);
    assert.ok(STATUSES.includes(item.status), `${slug}: status ${item.status}`);
    if (item.status === 'gate')
      assert.ok(RULES[item.rule], `${slug}: rule ${item.rule} does not exist`);
    if (item.status === 'covered')
      assert.ok(existsSync(item.file ?? ''), `${slug}: file ${item.file} does not exist`);
    if (item.status === 'open') assert.ok(item.gap, `${slug}: an open item names its gap`);
    if (item.status === 'declined' || item.status === 'not-applicable')
      assert.ok(item.reason, `${slug}: a ${item.status} item gives its reason`);
  }
});

test('every rule is used by a gate item', () => {
  const used = new Set(items.filter(([, i]) => i.status === 'gate').map(([, i]) => i.rule));
  for (const name of Object.keys(RULES))
    assert.ok(used.has(name), `${name} is not in the checklist`);
});

const page = (overrides = {}) => ({
  role: 'page',
  path: '/probe/a',
  status: 200,
  https: true,
  locale: 'nl',
  headers: {
    'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=()',
    'strict-transport-security': 'max-age=31536000',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'public, max-age=60',
  },
  body: `<!doctype html>
<html lang="nl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Een pagina</title>
<meta name="description" content="Waar het over gaat" />
<link rel="canonical" href="https://probe.example/a" />
<link rel="alternate" hreflang="nl" href="https://probe.example/a" />
<link rel="alternate" hreflang="x-default" href="https://probe.example/a" />
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
<meta property="og:title" content="Een pagina" /><meta property="og:description" content="Waar" />
<meta property="og:url" content="https://probe.example/a" /><meta property="og:type" content="article" />
<script type="module" src="/x.js"></script>
</head><body><a href="#main">Naar inhoud</a><header></header>
<main id="main"><h1>Een pagina</h1><h2>Deel</h2><h3>Stuk</h3><h2>Nog een</h2>
<img src="/m/1/w960.webp" alt="" width="960" height="540" /></main><footer></footer></body></html>`,
  ...overrides,
});
const samples = (p = page()) => [
  p,
  { ...page(), role: 'missing', path: '/probe/nope', status: 404, locale: undefined },
  { ...page(), role: 'revalidation', status: 304, body: '' },
  {
    ...page(),
    role: 'asset',
    path: '/_app/immutable/a.css',
    headers: { 'cache-control': 'public,max-age=31536000,immutable' },
  },
  {
    ...page(),
    role: 'font',
    path: '/fonts/inter.woff2',
    headers: { 'content-type': 'font/woff2' },
  },
  { ...page(), role: 'negotiation' },
];

test('a page that meets every gate passes', () => {
  assert.deepEqual(specFailures(checklist, samples()), []);
});

test('each rule fails on the defect it names', () => {
  const body = page().body;
  const cases = {
    doctype: { body: body.replace('<!doctype html>', '') },
    'html-lang': { body: body.replace('lang="nl"', 'lang="en"') },
    'meta-charset': { body: body.replace('<meta charset="utf-8" />', '') },
    'meta-viewport': { body: body.replace('initial-scale=1', 'maximum-scale=1') },
    title: { body: body.replace('<title>Een pagina</title>', '<title></title>') },
    'meta-description': { body: body.replace('Waar het over gaat', ' ') },
    'canonical-url': {
      body: body.replace(
        'href="https://probe.example/a" />\n<link rel="alternate" hreflang="nl"',
        'href="/a" />\n<link rel="alternate" hreflang="nl"'
      ),
    },
    'open-graph': { body: body.replace('og:url', 'og:link') },
    'meta-robots': {
      body: body.replace('</head>', '<meta name="robots" content="noindex" /></head>'),
    },
    'heading-hierarchy': { body: body.replace('<h3>Stuk</h3>', '<h4>Stuk</h4>') },
    'image-alt': { body: body.replace(' alt=""', '') },
    'skip-links': { body: body.replace('<a href="#main">Naar inhoud</a>', '') },
    'semantic-html': { body: body.replace('<footer></footer>', '') },
    hsts: { headers: { ...page().headers, 'strict-transport-security': 'max-age=60' } },
    'content-security-policy': {
      headers: {
        ...page().headers,
        'content-security-policy': "script-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
      },
    },
    'x-content-type-options': { headers: { ...page().headers, 'x-content-type-options': '' } },
    'cross-origin-isolation': {
      headers: { ...page().headers, 'cross-origin-resource-policy': 'cross-origin' },
    },
    vary: { headers: { ...page().headers, vary: 'accept-language' } },
    'frame-ancestors': {
      headers: { ...page().headers, 'content-security-policy': "default-src 'self'" },
    },
    'referrer-policy': { headers: { ...page().headers, 'referrer-policy': '' } },
    'permissions-policy': { headers: { ...page().headers, 'permissions-policy': '' } },
    'x-xss-protection': { headers: { ...page().headers, 'x-xss-protection': '1; mode=block' } },
    'cookie-attributes': { headers: { ...page().headers, 'set-cookie': 'sid=1; Path=/' } },
    'image-optimization': { body: body.replace('w960.webp', 'w960.png') },
    'cache-control': { headers: { ...page().headers, 'cache-control': '' } },
    'font-loading': {
      body: body.replace('/fonts/inter.woff2', 'https://fonts.example/inter.woff2'),
    },
    'script-loading': {
      body: body.replace('<script type="module" src="/x.js">', '<script src="/x.js">'),
    },
    hreflang: { body: body.replace('hreflang="x-default"', 'hreflang="en"') },
  };
  for (const [name, change] of Object.entries(cases)) {
    const failures = specFailures(checklist, samples(page(change)));
    assert.ok(
      failures.some((f) => f.startsWith(`${name} `)),
      `${name} did not fail: ${failures}`
    );
  }
  const by = (role, change) => samples().map((s) => (s.role === role ? { ...s, ...change } : s));
  assert.ok(
    specFailures(checklist, by('missing', { status: 200 })).some((f) => f.startsWith('soft-404'))
  );
  assert.ok(
    specFailures(checklist, by('revalidation', { status: 200 })).some((f) =>
      f.startsWith('conditional-requests')
    )
  );
  assert.ok(
    specFailures(checklist, by('negotiation', { status: 302 })).some((f) =>
      f.startsWith('avoid-auto-geo-redirects')
    )
  );
  assert.ok(
    specFailures(checklist, by('asset', { headers: { 'cache-control': 'max-age=60' } })).some((f) =>
      f.startsWith('cache-control')
    )
  );
});

test('a rule without a sample to check fails instead of passing', () => {
  const failures = specFailures(
    checklist,
    samples().filter((s) => s.role !== 'revalidation')
  );
  assert.ok(failures.includes('conditional-requests: no revalidation sample to check'));
});
