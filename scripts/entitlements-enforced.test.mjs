// Every entitlement a hoster can set does something (TODO #84). ADR 015 promises that a switch
// or limit narrows a tenant; a key that nothing reads accepts `false` or `0` and changes nothing,
// which a hoster cannot see. This ratchet fails `npm run lint:infra` when a switch or limit in
// `model.ts` is read by no source file outside the entitlements model and usage report, unless it
// is listed below as planned with the reason; a planned key that gets a reader must leave the
// list. Run offline.
// Rejected: removing the planned keys from the schema until they are built (a stored document
// that sets one would then be refused on its next write, and ADR 015 rule 2 names them), and
// enforcing them now (mail and donations have no sending or charging path that could refuse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isTest, stripComments, workspaceSources } from './lib/repo.mjs';

const MODEL = 'packages/core/src/entitlements/model.ts';

/** Files that name every key without enforcing one: the schema and the usage report. */
const NOT_A_READER = new Set([MODEL, 'packages/core/src/entitlements/service.ts']);

/** `key: why it has no reader yet`. Remove a line in the PR that starts enforcing the key. */
export const PLANNED = {
  'mailing.enabled': 'campaign mailing (ADR 010) is not built; confirmation mail is not mailing',
  'donations.enabled': 'donations (ADR 005) are phase 4',
  'mail.monthly_max': 'no campaign sending to count against; shown by tenant.usage.get',
};

/** The switch and limit names declared in `FEATURE_SWITCHES` and `LIMITS`. */
export function declaredKeys(model) {
  return ['FEATURE_SWITCHES', 'LIMITS'].flatMap((name) => {
    const list = model.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    assert.ok(list, `${MODEL} declares ${name}`);
    return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  });
}

/** `{ unread, plannedButRead }` for `keys` over `files`. */
export function audit(keys, files, planned = PLANNED) {
  const code = files
    .filter(({ path }) => !isTest(path) && !NOT_A_READER.has(path))
    .map(({ text }) => stripComments(text));
  const read = (key) => code.some((text) => text.includes(`'${key}'`));
  return {
    unread: keys.filter((k) => !read(k) && !(k in planned)),
    plannedButRead: keys.filter((k) => read(k) && k in planned),
  };
}

test('every switch and limit is read somewhere, or planned with a reason', () => {
  const keys = declaredKeys(readFileSync(join(ROOT, MODEL), 'utf8'));
  for (const key of Object.keys(PLANNED)) assert.ok(keys.includes(key), `${key} is declared`);
  assert.deepEqual(audit(keys, workspaceSources()), { unread: [], plannedButRead: [] });
});

test('the rule names an unread key and a planned key that got a reader', () => {
  const files = [
    { path: 'packages/core/src/x/service.ts', text: "requireEntitled(p, 'a');\n// 'c'" },
    { path: 'packages/core/src/x/service.test.ts', text: "'c'" },
    { path: MODEL, text: "'c'" },
  ];
  assert.deepEqual(audit(['a', 'b', 'c'], files, { b: 'later' }), {
    unread: ['c'],
    plannedButRead: [],
  });
  assert.deepEqual(audit(['a'], files, { a: 'later' }), { unread: [], plannedButRead: ['a'] });
});
