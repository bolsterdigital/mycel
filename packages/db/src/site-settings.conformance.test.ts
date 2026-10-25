// #11 E: real Postgres checks the RLS boundary and atomic baseVersion writes that the memory
// port cannot prove. The generic RLS/export suites also discover site_settings by catalog.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createUnitOfWork, migrate, upsertTenant, uuidv7, uuidv7Ids } from './index.js';
import { DEFAULT_THEME, DEFAULT_CHROME } from '@mycel/core';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

describe.skipIf(!operatorUrl || !appUrl)('site settings conformance', () => {
  const owner = createDb(operatorUrl ?? '');
  const app = createDb(appUrl ?? '');
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    })
  );
  let a = '';
  let b = '';
  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const run = Math.random().toString(36).slice(2, 8);
    a = (
      await upsertTenant(
        owner,
        {
          id: uuidv7(),
          slug: `site-a-${run}`,
          name: 'A',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
    b = (
      await upsertTenant(
        owner,
        {
          id: uuidv7(),
          slug: `site-b-${run}`,
          name: 'B',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
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
});
