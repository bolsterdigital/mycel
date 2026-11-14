// Migration 0057 (ADR 036 rule 10, #107 B2): `site_navigation_from_chrome` turns the retired chrome
// fields into the navigation document. The migration ran once, on whatever chrome existed then,
// so this suite writes chrome rows in the old shape and calls the function the way the import
// does (as mycel_app inside the tenant's context), then reads the result through the real use
// cases: the document must parse, resolve and publish exactly as rule 10 says. The backfill
// itself calls the same function for every site_settings row; the last test pins that.
//
// Rejected: replaying the backfill section over the shared test database, which alters RLS on
// four tables and would serialise against every suite running beside this one.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, anonymousPrincipal, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import type { Principal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { enterTenant } from '../infra/roles.js';
import type { Database } from '../infra/schema.js';
import { migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const OLD_CHROME = {
  navigation: [
    { href: '/over', label: { nl: 'Over ons', en: 'About us' } },
    { href: 'https://example.org/doneer', label: { nl: 'Doneer', junk: 'dropped' } },
  ],
  footer: { nl: 'Voettekst', en: 'Footer text' },
  legal: [{ href: '/privacy', label: { nl: 'Privacy', en: 'Privacy' } }],
  support: { href: '/steun', label: { nl: 'Steun ons' } },
  help: null,
};

describe.skipIf(skip)('migration 0057: chrome menus into the navigation document', () => {
  const owner = createDb(operatorUrl);
  const app = createDb(appUrl);
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
  const run = <K extends keyof typeof useCases>(name: K, p: Principal, input: unknown) =>
    invoker.run(useCases[name] as never, p, input as never) as Promise<any>;
  /** A site whose settings row exists (the footer save creates it), as every migrated site had. */
  const tenant = async (name: string) => {
    const { id } = await testTenant(owner, `chrome-${name}-${runSuffix()}`, {
      name: 'C',
      locales: ['nl', 'en'],
    });
    await run('updateSiteChrome', systemPrincipal(id, 'test'), {
      baseVersion: 0,
      chrome: { footer: {} },
    });
    return id;
  };
  /** Writes the chrome as it was stored before 0057 and runs the function as the import does. */
  const migrate = (id: string, chrome: unknown | null) =>
    app.transaction().execute(async (trx) => {
      await enterTenant(trx, id);
      if (chrome !== null)
        await sql`update site_settings set chrome = ${JSON.stringify(chrome)}::jsonb
                   where tenant_id = ${id}`.execute(trx);
      const { rows } = await sql<{ moved: boolean }>`
        select site_navigation_from_chrome(${id}::uuid, ${['nl', 'en']}::text[]) as moved`.execute(
        trx
      );
      return rows[0]!.moved;
    });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
  });
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  it('places the old menus, publishes them in every locale and keeps the footer text', async () => {
    const id = await tenant('fresh');
    expect(await migrate(id, OLD_CHROME)).toBe(true);
    const p = systemPrincipal(id, 'test');

    const draft = await run('getNavigation', p, {});
    expect(draft.document).toEqual({
      menus: [
        {
          id: 'chrome-main',
          name: 'Main menu',
          nodes: [
            {
              id: 'chrome-main-1',
              kind: 'link',
              target: { kind: 'url', href: '/over' },
              label: { nl: 'Over ons', en: 'About us' },
            },
            {
              id: 'chrome-main-2',
              kind: 'link',
              target: { kind: 'url', href: 'https://example.org/doneer' },
              label: { nl: 'Doneer' },
            },
          ],
        },
        {
          id: 'chrome-legal',
          name: 'Legal links',
          nodes: [
            {
              id: 'chrome-legal-1',
              kind: 'link',
              target: { kind: 'url', href: '/privacy' },
              label: { nl: 'Privacy', en: 'Privacy' },
            },
          ],
        },
        {
          id: 'chrome-footer',
          name: 'Support and help',
          nodes: [
            {
              id: 'chrome-footer-1',
              kind: 'link',
              target: { kind: 'url', href: '/steun' },
              label: { nl: 'Steun ons' },
            },
          ],
        },
      ],
      placements: {
        main: { menuId: 'chrome-main', bar: ['chrome-main-1', 'chrome-main-2'] },
        actions: null,
        footer: [{ menuId: 'chrome-footer' }],
        legal: { menuId: 'chrome-legal' },
      },
    });
    expect(draft.publication.map((x: { locale: string }) => x.locale).sort()).toEqual(['en', 'nl']);

    const visitor = anonymousPrincipal(id, ['content:read']);
    const nl = await run('resolveNavigation', visitor, { locale: 'nl' });
    expect(nl.main.nodes.map((n: { label: string }) => n.label)).toEqual(['Over ons', 'Doneer']);
    expect(nl.footer[0].nodes[0]).toMatchObject({ label: 'Steun ons' });
    expect(nl.legal.nodes[0]).toMatchObject({ label: 'Privacy' });
    // No implicit fallback any more (rule 10): a link without an English label is not shown in en.
    const en = await run('resolveNavigation', visitor, { locale: 'en' });
    expect(en.main.nodes.map((n: { label: string }) => n.label)).toEqual(['About us']);
    expect(en.footer).toEqual([]);

    // The chrome keeps its footer text and nothing else, so the strict schema reads it.
    expect((await run('getSiteChrome', p, {})).value).toEqual({ footer: OLD_CHROME.footer });
    // Running it again finds nothing to move.
    expect(await migrate(id, null)).toBe(false);
    expect((await run('getNavigation', p, {})).revisionId).toBe(draft.revisionId);
  });

  it('appends to an existing document as a draft and fills only empty placements', async () => {
    const id = await tenant('existing');
    const p = systemPrincipal(id, 'test');
    const first = await run('updateNavigation', p, {
      baseRevisionId: null,
      document: {
        menus: [
          {
            id: 'own',
            name: 'Own',
            nodes: [{ id: 'n1', kind: 'link', target: { kind: 'system', page: 'home' } }],
          },
        ],
        placements: {
          main: { menuId: 'own', bar: ['n1'] },
          actions: null,
          footer: [],
          legal: null,
        },
      },
    });
    await run('publishNavigation', p, { revisionId: first.revisionId, locale: 'nl' });

    expect(await migrate(id, OLD_CHROME)).toBe(true);
    const after = await run('getNavigation', p, {});
    expect(after.revisionId).not.toBe(first.revisionId);
    expect(after.document.menus.map((m: { id: string }) => m.id)).toEqual([
      'own',
      'chrome-main',
      'chrome-legal',
      'chrome-footer',
    ]);
    expect(after.document.placements).toEqual({
      main: { menuId: 'own', bar: ['n1'] },
      actions: null,
      footer: [{ menuId: 'chrome-footer' }],
      legal: { menuId: 'chrome-legal' },
    });
    // Nothing is published by the move: nl still points at the editor's revision.
    expect(after.publication).toEqual([
      expect.objectContaining({ locale: 'nl', revisionId: first.revisionId }),
    ]);
  });

  it('creates no navigation for a chrome without links, and only strips the fields', async () => {
    const id = await tenant('empty');
    expect(
      await migrate(id, {
        navigation: [],
        footer: { nl: 'Voet' },
        legal: [],
        support: null,
        help: null,
      })
    ).toBe(true);
    const p = systemPrincipal(id, 'test');
    expect((await run('getNavigation', p, {})).revisionId).toBeNull();
    expect((await run('getSiteChrome', p, {})).value).toEqual({ footer: { nl: 'Voet' } });
  });

  it('cannot reach another tenant through the function', async () => {
    const mine = await tenant('mine');
    const other = await tenant('other');
    const asTenant = <T>(id: string, body: (trx: Transaction<Database>) => Promise<T>) =>
      app.transaction().execute(async (trx) => {
        await enterTenant(trx, id);
        return body(trx);
      });
    await asTenant(other, (trx) =>
      sql`update site_settings set chrome = ${JSON.stringify(OLD_CHROME)}::jsonb
           where tenant_id = ${other}`.execute(trx)
    );
    const moved = await asTenant(mine, async (trx) => {
      const { rows } = await sql<{ moved: boolean }>`
        select site_navigation_from_chrome(${other}::uuid, ${['nl']}::text[]) as moved`.execute(
        trx
      );
      return rows[0]!.moved;
    });
    expect(moved).toBe(false);
    const still = await asTenant(other, async (trx) => {
      const { rows } = await sql<{ chrome: { navigation?: unknown[] } }>`
        select chrome from site_settings where tenant_id = ${other}`.execute(trx);
      return rows[0]!.chrome.navigation?.length;
    });
    expect(still).toBe(2);
  });

  it('runs the function for every site in the backfill', async () => {
    const text = await readFile(
      fileURLToPath(new URL('../../migrations/0057_chrome_navigation.sql', import.meta.url)),
      'utf8'
    );
    const backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toMatch(
      /select site_navigation_from_chrome\(s\.tenant_id, tn\.locales\)\s+from site_settings s join tenants tn/
    );
  });
});
