// #11 E: real Postgres checks the RLS boundary and atomic baseVersion writes that the memory
// port cannot prove. The generic RLS/export suites also discover site_settings by catalog.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { DEFAULT_THEME, DEFAULT_CHROME, DEFAULT_GENERAL, DEFAULT_IMAGES } from '@mycel/core';
import { createDb, createUnitOfWork, uuidv7Ids } from './index.js';
import type { Database } from './infra/schema.js';
import { enterTenant } from './infra/roles.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('site settings conformance', () => {
  const owner = createDb(operatorUrl);
  const queries: string[] = [];
  // The app connection with a query log, so a test can assert what a read selects.
  const app = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 10 }) }),
    log: (event) => {
      if (event.level === 'query') queries.push(event.query.sql);
    },
  });
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
      brandProcessor: {
        logo: async (bytes) => ({
          bytes,
          contentType: 'image/webp' as const,
          width: 1,
          height: 1,
          licence: null,
        }),
        font: async () => {},
      },
    })
  );
  let a = '';
  let b = '';
  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const run = runSuffix();
    a = (await testTenant(owner, `site-a-${run}`, { name: 'A', locales: ['nl', 'en'] })).id;
    b = (await testTenant(owner, `site-b-${run}`, { name: 'B', locales: ['nl', 'en'] })).id;
  });
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });
  it('separates tenants and serialises competing writes', async () => {
    const principal = systemPrincipal(a, 'test');
    const aTheme = { ...DEFAULT_THEME, baseSize: 20 };
    const writes = await Promise.allSettled(
      [19, 20].map((baseSize) =>
        invoker.run(useCases.updateSiteTheme, principal, {
          baseVersion: 0,
          theme: { ...aTheme, baseSize },
        })
      )
    );
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await invoker.run(useCases.getSiteTheme, principal, {})).version).toBe(1);
    expect(await invoker.run(useCases.getSiteTheme, systemPrincipal(b, 'test'), {})).toMatchObject({
      version: 0,
      value: DEFAULT_THEME,
    });
    const chrome = { ...DEFAULT_CHROME, footer: { nl: 'Voet', en: 'Footer' } };
    expect(
      await invoker.run(useCases.updateSiteChrome, principal, { baseVersion: 0, chrome })
    ).toMatchObject({ version: 1 });
    expect(await invoker.run(useCases.getSiteChrome, principal, {})).toMatchObject({
      version: 1,
      value: chrome,
    });
    expect(await invoker.run(useCases.getSiteChrome, systemPrincipal(b, 'test'), {})).toMatchObject(
      { version: 0, value: DEFAULT_CHROME }
    );
  });
  it('gives every site Europe/Amsterdam until it chooses a zone of its own (#88)', async () => {
    const principal = systemPrincipal(a, 'test');
    expect(DEFAULT_GENERAL).toEqual({ timeZone: 'Europe/Amsterdam' });
    expect(await invoker.run(useCases.getSiteGeneral, principal, {})).toEqual({
      version: 0,
      value: DEFAULT_GENERAL,
    });
    const general = { timeZone: 'Europe/Berlin' };
    expect(
      await invoker.run(useCases.updateSiteGeneral, principal, { baseVersion: 0, general })
    ).toEqual({ version: 1, value: general });
    await expect(
      invoker.run(useCases.updateSiteGeneral, principal, { baseVersion: 0, general })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await invoker.run(useCases.getSiteGeneral, principal, {})).toEqual({
      version: 1,
      value: general,
    });
    expect(await invoker.run(useCases.getSiteGeneral, systemPrincipal(b, 'test'), {})).toEqual({
      version: 0,
      value: DEFAULT_GENERAL,
    });
  });
  it('keeps the default image apart from the other documents (#86)', async () => {
    const principal = systemPrincipal(a, 'test');
    const before = await invoker.run(useCases.getSiteImages, principal, {});
    expect(before.value).toEqual(DEFAULT_IMAGES);
    expect(
      await invoker.run(useCases.updateSiteImages, principal, {
        baseVersion: before.version,
        images: { defaultImageId: null },
      })
    ).toEqual({ version: before.version + 1, value: DEFAULT_IMAGES });
    await expect(
      invoker.run(useCases.updateSiteImages, principal, {
        baseVersion: before.version,
        images: { defaultImageId: null },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(useCases.updateSiteImages, principal, {
        baseVersion: before.version + 1,
        images: { defaultImageId: '01900000-0000-7000-8000-00000000dddd' },
      })
    ).rejects.toMatchObject({ issues: [{ message: 'content.reference.media-unknown' }] });
    expect(
      (await invoker.run(useCases.getSiteImages, systemPrincipal(b, 'test'), {})).version
    ).toBe(0);
  });
  it('falls back to the default zone when the stored one is no longer known (#81-rest)', async () => {
    const principal = systemPrincipal(a, 'test');
    const before = await invoker.run(useCases.getSiteGeneral, principal, {});
    await owner.transaction().execute(async (trx) => {
      await enterTenant(trx, a);
      await trx
        .updateTable('site_settings')
        .set({ general: JSON.stringify({ timeZone: 'Mars/Olympus_Mons' }) })
        .where('tenant_id', '=', a)
        .execute();
    });
    expect(await invoker.run(useCases.getSiteGeneral, principal, {})).toEqual({
      version: before.version,
      value: DEFAULT_GENERAL,
    });
  });
  it('isolates brand bytes and versions under the same forced RLS row', async () => {
    const aPrincipal = systemPrincipal(a, 'test');
    const bPrincipal = systemPrincipal(b, 'test');
    const bytes = useCases.uploadMedia.examples[0].input.bytes;
    expect(
      await invoker.run(useCases.putBrandAsset, aPrincipal, {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes,
      })
    ).toMatchObject({ version: 1, active: true });
    expect(await invoker.run(useCases.getBrandAsset, bPrincipal, { kind: 'logo' })).toMatchObject({
      version: 0,
      active: false,
    });
    await expect(
      invoker.run(useCases.putBrandAsset, aPrincipal, {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await invoker.run(useCases.removeBrandAsset, aPrincipal, { kind: 'logo', baseVersion: 1 })
    ).toMatchObject({ version: 2, active: false });
    expect(await invoker.run(useCases.getBrandAsset, bPrincipal, { kind: 'logo' })).toMatchObject({
      version: 0,
      active: false,
    });
  });

  it('stores only what was written, so the other settings follow the defaults', async () => {
    const principal = systemPrincipal(b, 'test');
    const chrome = { ...DEFAULT_CHROME, footer: { nl: 'Alleen voet', en: 'Footer only' } };
    await invoker.run(useCases.updateSiteChrome, principal, { baseVersion: 0, chrome });
    const row = await owner
      .selectFrom('site_settings')
      .select(['theme', 'theme_version', 'chrome_version'])
      .where('tenant_id', '=', b)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ theme: null, theme_version: 0, chrome_version: 1 });
    expect(await invoker.run(useCases.getSiteTheme, principal, {})).toEqual({
      version: 0,
      value: DEFAULT_THEME,
    });
    await expect(
      invoker.run(useCases.updateSiteTheme, principal, { baseVersion: 1, theme: DEFAULT_THEME })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await invoker.run(useCases.updateSiteTheme, principal, {
        baseVersion: 0,
        theme: { ...DEFAULT_THEME, baseSize: 18 },
      })
    ).toMatchObject({ version: 1 });
  });

  it('reads one brand kind without the other kind’s bytes', async () => {
    const principal = systemPrincipal(a, 'test');
    queries.length = 0;
    await invoker.run(useCases.getBrandAsset, principal, { kind: 'logo' });
    const read = queries.filter((q) => q.includes('from "site_settings"'));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('"logo_bytes"');
    expect(read[0]).not.toContain('"font_bytes"');
    expect(read[0]).not.toContain('*');
  });
});
