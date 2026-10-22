// Exercise the real scanner and allow-list in CI, where Docker and the pinned image already
// exist. A substring exception can hide a provider token containing a development placeholder;
// checking TOML syntax alone would miss that regression. Inputs are synthetic and assembled so
// no credential-shaped fixture needs a path exception in the history scan.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = 'ghcr.io/gitleaks/gitleaks:v8.30.1';
function scan(input) {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      `${root}:/repo:ro`,
      image,
      'stdin',
      '--config',
      '/repo/.gitleaks.toml',
      '--redact',
      '--no-banner',
    ],
    { input, encoding: 'utf8' }
  );
}

test('known development placeholders remain allowed', () => {
  const result = scan('secret="ci-only-signing-secret"\npassword="mycel_auth_ci"\n');
  assert.equal(result.status, 0, result.stderr);
});

for (const marker of ['mycel_auth_ci', 'change-me']) {
  test(`a provider token containing ${marker} is still detected`, () => {
    const token = ['glpat', '-', marker, 'A7b9C2d4F6g8H1j3K5m7'.slice(marker.length)].join('');
    const result = scan(`token="${token}"\n`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /leaks found: 1/);
  });
}
