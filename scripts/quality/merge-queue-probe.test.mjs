// Disposable merge-queue probe (never merged): green on its own, red on top of the PR that adds
// .github/main-ruleset.json, so the queue must drop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('probe: main-ruleset.json is absent', () => {
  assert.equal(existsSync(new URL('../../.github/main-ruleset.json', import.meta.url)), false);
});
