// A site's uploaded fonts against Postgres (MY-302, migration 0092): the platform operation adds,
// replaces and removes faces under the tenant's RLS and writes its audit row in the same
// transaction; a refused file or a second family name writes nothing; another tenant never sees
// the rows; the tenant port reads exactly what was written. Skips without DATABASE_URL; in CI
// that is a failure.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeInputHasher, runSuffix } from '@mycel/core/testing';
import { createDb, listSiteFontsOf, removeSiteFont, uploadSiteFontFace } from '../index.js';
import { enterTenant } from '../infra/roles.js';
import { siteFontsRepository } from './site-fonts.js';
import { requireDatabase, testTenant, migrateSchema } from '../testing.js';

const { skip, operator: operatorUrl } = requireDatabase();
const FONT = resolve(
  import.meta.dirname,
  '../../../../apps/web/static/fonts/inter/inter-latin-roman.woff2'
);

describe.skipIf(skip)('site fonts', () => {
  const owner = createDb(operatorUrl);
  const by = { actorId: 'cli', hasher: new FakeInputHasher() };
  const ok = () => {};
  let a = '';
  let b = '';
  let bytes = new Uint8Array();
  const family = (name = 'Gottak', role: 'heading' | 'body' = 'heading') => ({
    role,
    family: name,
    category: 'sans' as const,
    licence: { holder: 'Tegenmacht', source: 'Example Foundry', domains: ['example.org'] },
  });
  const upload = (
    tenant: string,
    over: Partial<{
      weight: number;
      style: 'normal' | 'italic';
      name: string;
      replace: boolean;
    }> = {}
  ) =>
    uploadSiteFontFace(
      owner,
      tenant,
      {
        family: family(over.name),
        weight: over.weight ?? 700,
        style: over.style ?? 'normal',
        bytes,
        replaceFamily: over.replace ?? false,
      },
      by,
      ok
    );
  const audits = (tenant: string) =>
    owner
      .selectFrom('audit_log')
      .select('operation')
      .where('tenant_id', '=', tenant)
      .where('operation', 'like', 'platform.site.font.%')
      .execute();

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const run = runSuffix();
    a = (await testTenant(owner, `fonts-a-${run}`)).id;
    b = (await testTenant(owner, `fonts-b-${run}`)).id;
    bytes = new Uint8Array(await readFile(FONT));
  });
  afterAll(() => owner.destroy());

  it('adds faces to one family and serves their bytes to the tenant only', async () => {
    await upload(a);
    const font = await upload(a, { weight: 400, style: 'italic' });
    expect(font.family).toBe('Gottak');
    expect(font.faces.map((f) => `${f.weight} ${f.style}`)).toEqual(['700 normal', '400 italic']);
    expect(font.faces[0]!.bytes).toBe(bytes.length);
    expect(font.licence.domains).toEqual(['example.org']);

    const read = await owner.transaction().execute(async (trx) => {
      await enterTenant(trx, a);
      return siteFontsRepository(trx, a).face('heading', 700, 'normal');
    });
    expect(read?.bytes).toEqual(bytes);
    expect(await listSiteFontsOf(owner, b)).toEqual([]);
    const other = await owner.transaction().execute(async (trx) => {
      await enterTenant(trx, b);
      const r = await sql<{ n: string }>`select count(*) as n from site_font_faces`.execute(trx);
      return Number(r.rows[0]!.n);
    });
    expect(other).toBe(0);
    expect((await audits(a)).map((r) => r.operation)).toEqual([
      'platform.site.font.upload',
      'platform.site.font.upload',
    ]);
  });

  it('refuses a second family name for a role unless it is replaced, and then drops the old faces', async () => {
    await expect(upload(a, { name: 'Nudica' })).rejects.toThrow('site.font.family.other');
    const replaced = await upload(a, { name: 'Nudica', weight: 500, replace: true });
    expect(replaced.family).toBe('Nudica');
    expect(replaced.faces.map((f) => f.weight)).toEqual([500]);
  });

  it('writes nothing, not even an audit row, for a file the validator refuses', async () => {
    const before = (await audits(a)).length;
    await expect(
      uploadSiteFontFace(
        owner,
        a,
        { family: family('Nudica'), weight: 900, style: 'normal', bytes, replaceFamily: false },
        by,
        () => {
          throw new Error('site.brand.font.header');
        }
      )
    ).rejects.toThrow('site.brand.font.header');
    expect((await audits(a)).length).toBe(before);
    const [font] = await listSiteFontsOf(owner, a);
    expect(font!.faces.map((f) => f.weight)).toEqual([500]);
  });

  it('removes a face, and with the last face the family', async () => {
    await upload(a, { name: 'Nudica', weight: 300 });
    expect(await removeSiteFont(owner, a, 'heading', { weight: 300, style: 'normal' }, by)).toBe(
      true
    );
    expect((await listSiteFontsOf(owner, a))[0]!.faces).toHaveLength(1);
    expect(await removeSiteFont(owner, a, 'heading', { weight: 500, style: 'normal' }, by)).toBe(
      true
    );
    expect(await listSiteFontsOf(owner, a)).toEqual([]);
    expect(await removeSiteFont(owner, a, 'heading', null, by)).toBe(false);
  });
});
