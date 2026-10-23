// The restore drill passes only when `compare` finds nothing (scripts/drill-run.sh), so a compare
// that misses a difference turns every drill green. This runs it on fingerprints that differ in
// each way a restore can go wrong, without a database.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('drill-verify.mjs', import.meta.url));
const before = {
  lastMigration: '0018_db_boundaries',
  tables: {
    tenants: { '-': { rows: 2, sha256: 'a' } },
    supporters: { t1: { rows: 1, sha256: 'b' }, t2: { rows: 1, sha256: 'c' } },
  },
  blobs: { 't1/x.jpg': 'd' },
  roles: {
    mycel_app: { login: true, inherit: true, memberships: [] },
    mycel_authenticator: { login: true, inherit: true, memberships: ['mycel_auth inherit f'] },
  },
};

function compare(after) {
  const dir = mkdtempSync(join(tmpdir(), 'drill-verify-'));
  try {
    writeFileSync(join(dir, 'before.json'), JSON.stringify(before));
    writeFileSync(join(dir, 'after.json'), JSON.stringify(after));
    return spawnSync(
      'node',
      [script, 'compare', join(dir, 'before.json'), join(dir, 'after.json')],
      {
        encoding: 'utf8',
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('equal fingerprints pass and say what was compared', () => {
  const r = compare(before);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /2 tables, 2 tenant rows, 1 media objects, 2 roles, migration 0018_db_boundaries/
  );
});

test('a lost tenant, a changed row, a lost or extra object, a role and a migration all fail', () => {
  const r = compare({
    lastMigration: '0017_content_block_refs',
    tables: {
      tenants: { '-': { rows: 2, sha256: 'changed' } },
      supporters: { t1: { rows: 1, sha256: 'b' } },
    },
    blobs: { 't1/y.jpg': 'e' },
    roles: {
      mycel_app: { login: true, inherit: true, memberships: [] },
      mycel_authenticator: { login: true, inherit: false, memberships: [] },
    },
  });
  assert.equal(r.status, 1);
  for (const line of [
    'role mycel_authenticator: {"login":true,"inherit":true,"memberships":["mycel_auth inherit f"]} -> {"login":true,"inherit":false,"memberships":[]}',
    'last migration: 0018_db_boundaries -> 0017_content_block_refs',
    'tenants [-]: 2 rows -> 2 rows',
    'supporters [t2]: 1 rows -> absent rows',
    'blob t1/x.jpg: changed or lost',
    'blob t1/y.jpg: appeared',
  ])
    assert.ok(r.stderr.includes(line), `${line}\n${r.stderr}`);
});
