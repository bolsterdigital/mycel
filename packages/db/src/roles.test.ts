// The role and lock helper against a real Postgres (skips without DATABASE_URL, like db.test.ts).

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from './index.js';
import { advisoryLock, asRole, setRole } from './roles.js';
import { requireDatabase } from './testing.js';

const { skip, operator: operatorUrl } = requireDatabase();

describe.skipIf(skip)('roles', () => {
  const db = createDb(operatorUrl);
  afterAll(() => db.destroy());

  const currentUser = async (trx: typeof db) =>
    (await sql<{ u: string }>`select current_user as u`.execute(trx)).rows[0]?.u;

  it('runs one transaction as the role and leaves the connection as it was', async () => {
    const before = await currentUser(db);
    expect(await asRole(db, 'mycel_worker', currentUser)).toBe('mycel_worker');
    expect(
      await db.transaction().execute(async (trx) => {
        await setRole(trx, 'mycel_platform');
        return currentUser(trx);
      })
    ).toBe('mycel_platform');
    expect(await currentUser(db)).toBe(before);
  });

  it('locks scope plus parts until commit, and no other scope on the same id', async () => {
    const id = crypto.randomUUID();
    const tryLock = (key: string) =>
      db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ ok: boolean }>`
          select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`.execute(trx);
        return rows[0]?.ok;
      });
    const held = await db.transaction().execute(async (trx) => {
      await advisoryLock(trx, 'supporter', id, 'a@example.org');
      return {
        same: await tryLock(`supporter:${id}:a@example.org`),
        otherScope: await tryLock(`media:${id}:a@example.org`),
        otherPart: await tryLock(`supporter:${id}:b@example.org`),
      };
    });
    expect(held).toEqual({ same: false, otherScope: true, otherPart: true });
    expect(await tryLock(`supporter:${id}:a@example.org`)).toBe(true);
  });
});
