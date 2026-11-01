// Caddyfile.ci may differ from the production Caddyfile only in TLS lines (TODO #18a), so the CI
// compose proof tests the routing that production runs: which paths are closed from outside,
// where requests go and which headers they carry. Comments and blank lines are free; every other
// line must be equal once lines naming `tls`, `on_demand` or `local_certs` are set aside.
// Rejected: generating Caddyfile.ci from Caddyfile in CI, which hides the file a reader compares.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const TLS = /\b(tls|on_demand|local_certs)\b/;

/** The directive lines of a Caddyfile, without comments and blank lines. */
const directives = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/** Every directive line that differs and is not a TLS line; empty when only TLS differs. */
export function routingDiff(production, ci) {
  const a = directives(production).filter((l) => !TLS.test(l));
  const b = directives(ci).filter((l) => !TLS.test(l));
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) diff.push(`line ${i + 1}: ${a[i] ?? '(none)'} | ${b[i] ?? '(none)'}`);
  return diff;
}

const production = read('Caddyfile');
const ci = read('Caddyfile.ci');

test('the CI Caddyfile routes exactly like production', () => {
  assert.deepEqual(routingDiff(production, ci), []);
});

test('production issues on demand after asking the application; CI only adds its own CA', () => {
  assert.match(production, /^\s*ask http:\/\/web:3000\/internal\/hostnames\/allowed$/m);
  assert.match(production, /^\s*on_demand$/m);
  assert.doesNotMatch(directives(production).join('\n'), /local_certs|tls internal/);
  assert.match(ci, /^\s*local_certs$/m);
  assert.match(ci, /^\s*on_demand$/m);
});

test('the paths that must stay closed from outside answer 404', () => {
  const lines = directives(production);
  assert.ok(lines.includes('@internal path /internal/* /readyz /metrics'));
  assert.ok(lines.includes('@internal path /readyz /metrics /platform /platform/*'));
  assert.equal(lines.filter((l) => l === 'respond @internal 404').length, 2);
});

test('files outside the application get their headers from the sites block alone', () => {
  const lines = directives(production);
  for (const line of [
    '?X-Content-Type-Options nosniff',
    '?Cross-Origin-Resource-Policy same-origin',
    '?Strict-Transport-Security max-age=31536000',
    '@fonts path /fonts/*',
    'header @fonts ?Cache-Control "public, max-age=31536000, immutable"',
    '@scripts path /_admin/* /_form/*',
    'header @scripts ?Cache-Control no-cache',
  ])
    assert.equal(lines.filter((l) => l === line).length, 1, line);
});

test('a routing change in only one file is caught', () => {
  const opened = ci.replace(
    '@internal path /internal/* /readyz /metrics',
    '@internal path /readyz'
  );
  assert.deepEqual(routingDiff(production, opened), [
    'line 19: @internal path /internal/* /readyz /metrics | @internal path /readyz',
  ]);
  assert.notDeepEqual(
    routingDiff(production, ci.replace('reverse_proxy web:3000', 'reverse_proxy api:3000')),
    []
  );
});
