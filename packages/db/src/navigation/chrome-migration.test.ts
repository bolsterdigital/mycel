// Migration 0057 (ADR 036 rule 10 as amended 2026-11-15): the backfill strips the four retired
// menu fields from every site's chrome and keeps the footer text. The migrator applied it once,
// on whatever chrome existed then, so this suite replays the SQL between the `backfill:begin`
// and `backfill:end` markers as the owner, over a chrome row it writes in the old shape inside a
// transaction it rolls back, and checks that RLS is forced again afterwards.
//
// Rejected: committing an old-shape row to the shared test database, where any suite reading
// that tenant's chrome would meet fields the schema refuses.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSuffix } from '@mycel/core/testing';
import { createDb } from '../index.js';
import { migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl } = requireDatabase();

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0057_chrome_navigation.sql', import.meta.url)
);

describe.skipIf(skip)('migration 0057 backfill', () => {
  const owner = createDb(operatorUrl);
  let backfill = '';

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
  });
  afterAll(async () => {
    await owner.destroy();
  });

  it('strips the four menu fields and keeps the footer text', async () => {
    const { id } = await testTenant(owner, `chrome-strip-${runSuffix()}`, {
      name: 'C',
      locales: ['nl'],
    });
    const client = new pg.Client({ connectionString: operatorUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query('alter table site_settings no force row level security');
      await client.query(
        `insert into site_settings (tenant_id, theme, chrome) values ($1, '{}', $2)
          on conflict (tenant_id) do update set chrome = excluded.chrome`,
        [
          id,
          JSON.stringify({
            navigation: [{ href: '/over', label: { nl: 'Over ons' } }],
            footer: { nl: 'Voettekst' },
            legal: [],
            support: { href: '/steun', label: { nl: 'Steun ons' } },
            help: null,
          }),
        ]
      );

      await client.query(backfill);

      const { rows: forced } = await client.query<{ forced: boolean }>(
        `select relforcerowsecurity as forced from pg_class
          where relname = 'site_settings' and relkind = 'r'`
      );
      expect(forced).toEqual([{ forced: true }]);
      await client.query('alter table site_settings no force row level security');
      const { rows } = await client.query<{ chrome: unknown }>(
        'select chrome from site_settings where tenant_id = $1',
        [id]
      );
      expect(rows).toEqual([{ chrome: { footer: { nl: 'Voettekst' } } }]);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });
});
