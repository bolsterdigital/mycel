// Site imports against Postgres (0088, MY-257 PR 3): what the memory store cannot prove. The row
// is tenant data under forced RLS; the partial unique index allows one queued or running import
// per site; the file leaves the row when the run ends; `retention.apply` deletes rows past their
// term but never a running one; and an import does not travel in a tenant export.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  claimImport,
  finishImport,
  retentionCutoffs,
  useCases,
  type ImportPlanner,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  expectCode,
  memoryPlatform,
  principal,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { applyRetention } from '../infra/retention.js';
import { readTenant } from '../portability/export.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const planner: ImportPlanner = {
  plan: () => ({
    site: { title: 'Bron', url: 'https://bron.example' },
    defaultLocale: 'nl',
    locales: ['nl'],
    counts: {
      pages: 1,
      pagesDraft: 0,
      articles: 1,
      articlesDraft: 0,
      media: 0,
      people: 1,
      groups: 0,
      sections: 0,
      campaigns: 0,
    },
    lines: [{ code: 'person.failed', title: 'Anna de Vries' }],
    moreLines: 0,
  }),
};

describe.skipIf(skip)('content imports conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns({}),
    platform: memoryPlatform,
    importPlanner: planner,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  const tenants: string[] = [];
  let admin: Principal;
  const upload = (p: Principal = admin) =>
    invoker.run(useCases.uploadImport, p, {
      fileName: 'export.xml',
      bytes: Buffer.from('<rss/>').toString('base64'),
    });
  const source = async (id: string) =>
    (
      await sql<{ n: number | null }>`select octet_length(source) as n from content_imports
        where id = ${id}`.execute(operatorDb)
    ).rows[0]?.n;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const tenant = (await testTenant(operatorDb, `import-${run}`)).id;
    tenants.push(tenant);
    admin = principal({ tenantId: tenant });
  });
  afterAll(async () => {
    if (tenants.length) await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('keeps the file until the run ends, one active import per site, and no copy in an export', async () => {
    const first = await upload();
    expect(await source(first.id)).toBe(6);
    await invoker.run(useCases.confirmImport, admin, { importId: first.id });
    // A second import confirmed past the use case's own check meets the partial unique index.
    const second = await upload();
    await expectCode(
      uow.run(admin, (ctx) => ctx.contentImports.update({ ...second, status: 'queued' } as never)),
      'conflict'
    );
    const claim = await uow.run(admin, (ctx) => claimImport(ctx, first.id));
    expect(claim).toMatchObject({ kind: 'start', xml: '<rss/>' });
    await uow.run(admin, (ctx) =>
      finishImport(ctx, first.id, { outcome: { items: [], lines: [], moreLines: 0 } })
    );
    expect(await source(first.id)).toBeNull();
    const { imports } = await invoker.run(useCases.listImports, admin, {});
    expect(imports.map((i) => [i.id, i.status])).toEqual([
      [second.id, 'planned'],
      [first.id, 'done'],
    ]);
    const tables = new Set<string>();
    await readTenant(operatorDb, admin.tenantId, (table) => tables.add(table));
    expect(tables.has('content_imports')).toBe(false);
  });

  it('shows another site nothing and lets it delete nothing of this site', async () => {
    const mine = await upload();
    const other = (await testTenant(operatorDb, `import-b-${run}`)).id;
    tenants.push(other);
    const stranger = principal({ tenantId: other });
    expect((await invoker.run(useCases.listImports, stranger, {})).imports).toEqual([]);
    await expectCode(
      invoker.run(useCases.deleteImport, stranger, { importId: mine.id }),
      'not_found'
    );
  });

  it('deletes imports past their term as mycel_retention, but never a running one', async () => {
    const old = await upload();
    await invoker.run(useCases.confirmImport, admin, { importId: old.id }).catch(() => undefined);
    await sql`update content_imports set created_at = now() - interval '40 days'
      where tenant_id = ${admin.tenantId}`.execute(operatorDb);
    const before = (
      await sql<{ status: string }>`select status from content_imports
        where tenant_id = ${admin.tenantId}`.execute(operatorDb)
    ).rows.map((r) => r.status);
    const active = before.filter((s) => s === 'queued' || s === 'running').length;
    const gone = await applyRetention(
      operatorDb,
      admin.tenantId,
      retentionCutoffs(new Date(), { submissionMonths: 24 })
    );
    expect(gone.imports).toBe(before.length - active);
    const left = await sql<{ n: string }>`select count(*) as n from content_imports
      where tenant_id = ${admin.tenantId}`.execute(operatorDb);
    expect(Number(left.rows[0]!.n)).toBe(active);
  });
});
