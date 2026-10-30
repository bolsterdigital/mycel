// The seed key against Postgres: a token seeded before with fewer capabilities, revoked, or owned
// by another tenant makes the seed refuse instead of leaving a key that 403s; a complete key is a
// no-op on rerun. Postgres because the refusal starts at the unique key_hash, which only the
// database enforces across tenants.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, systemPrincipal, type KeyCapability } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids } from './index.js';
import { SEED_KEY_CAPABILITIES, seedApiKey } from './seed-key.js';
import { requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('seed key', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  let admin = systemPrincipal(uuidv7(), 'seed');
  let other = admin;

  beforeAll(async () => {
    admin = systemPrincipal((await testTenant(operatorDb, `seed-key-a-${run}`)).id, 'seed');
    other = systemPrincipal((await testTenant(operatorDb, `seed-key-b-${run}`)).id, 'seed');
  });

  afterAll(async () => {
    await Promise.all([operatorDb.destroy(), appDb.destroy()]);
  });

  const seedKeys = async () =>
    (await uow.run(admin, (ctx) => ctx.apiKeys.list())).filter((k) => k.name === 'seed');

  /** A "seed" row as an older seed left it, with its own capability list. */
  const storeOld = async (capabilities: KeyCapability[]) => {
    const { token, prefix, hash } = await generateApiKey();
    await uow.run(admin, (ctx) =>
      ctx.apiKeys.insert({
        id: uuidv7(),
        name: 'seed',
        prefix,
        keyHash: hash,
        capabilities,
        createdBy: admin.actor,
        createdAt: new Date(),
      })
    );
    return token;
  };

  it('creates the key once with every seed capability, and a rerun changes nothing', async () => {
    const { token } = await generateApiKey();
    expect(await seedApiKey(uow, admin, token)).toBe('created');
    expect(await seedApiKey(uow, admin, token)).toBe('present');
    const prefix = token.slice(0, 12);
    const rows = (await seedKeys()).filter((k) => k.prefix === prefix);
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.capabilities].sort()).toEqual([...SEED_KEY_CAPABILITIES].sort());
  });

  it('refuses a key seeded before with fewer capabilities, naming what is missing', async () => {
    const token = await storeOld(SEED_KEY_CAPABILITIES.filter((c) => c !== 'media:read'));
    await expect(seedApiKey(uow, admin, token)).rejects.toThrow(
      /fewer capabilities \(missing media:read\).*new MYCEL_API_KEY/
    );
  });

  it('refuses a revoked key', async () => {
    const token = await storeOld([...SEED_KEY_CAPABILITIES]);
    const prefix = token.slice(0, 12);
    const row = (await seedKeys()).find((k) => k.prefix === prefix)!;
    await uow.run(admin, (ctx) => ctx.apiKeys.revoke(row.id, new Date()));
    await expect(seedApiKey(uow, admin, token)).rejects.toThrow(/revoked/);
  });

  it("refuses a token that is another tenant's key", async () => {
    const { token } = await generateApiKey();
    expect(await seedApiKey(uow, other, token)).toBe('created');
    await expect(seedApiKey(uow, admin, token)).rejects.toThrow(/another tenant/);
  });
});
