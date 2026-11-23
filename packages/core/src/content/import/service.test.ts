// A site import from the admin over the memory store (MY-257 PR 3): the dry run on upload, one
// planned import at a time, confirm plans the job, one run per site, a run is never repeated,
// the file goes when the run ends, and only `tenant:admin` may do any of it. The importer itself
// is tested in packages/import-wordpress; the Postgres half in packages/db.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { MemoryUnitOfWork, TENANT, expectCode, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { IMPORT_MAX_LINES, keptLines, type ImportSummary } from './model.js';
import { ImportUnreadable, type ImportPlanner } from './ports.js';
import { IMPORT_INTERRUPTED, claimImport, finishImport } from './service.js';

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  site: { title: 'Bron', url: 'https://bron.example' },
  defaultLocale: 'nl',
  locales: ['nl'],
  counts: {
    pages: 1,
    pagesDraft: 0,
    articles: 2,
    articlesDraft: 1,
    media: 3,
    people: 1,
    groups: 0,
    sections: 1,
    campaigns: 0,
  },
  lines: [{ code: 'block.skipped', postId: 4, block: 'core/html', position: 2 }],
  moreLines: 0,
  ...over,
});

/** Reads `<wxr/>` as an export and anything else as no export; records the options it got. */
function planner(): ImportPlanner & { calls: { defaultLocale?: string }[] } {
  const calls: { defaultLocale?: string }[] = [];
  return {
    calls,
    plan(xml, options) {
      calls.push(options);
      if (!xml.includes('<wxr')) throw new ImportUnreadable('no channel');
      return summary(options.defaultLocale ? { defaultLocale: options.defaultLocale } : {});
    },
  };
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

function setup() {
  const plan = planner();
  const uow = new MemoryUnitOfWork({ importPlanner: plan });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal();
  const upload = (text = '<wxr/>', over: Record<string, unknown> = {}) =>
    invoker.run(useCases.uploadImport, admin, { fileName: 'export.xml', bytes: b64(text), ...over });
  const inTenant = <T>(fn: Parameters<MemoryUnitOfWork['run']>[1]) =>
    uow.run(principal(), fn) as Promise<T>;
  return { plan, uow, invoker, admin, upload, inTenant };
}

describe('content.import', () => {
  it('stores the dry run and the file of an upload, and replaces an earlier planned one', async () => {
    const { plan, uow, invoker, admin, upload } = setup();
    const first = await upload('<wxr/>', { defaultLocale: 'en' });
    expect(first).toMatchObject({ status: 'planned', fileName: 'export.xml', outcome: null });
    expect(first.summary.defaultLocale).toBe('en');
    expect(plan.calls).toEqual([{ defaultLocale: 'en' }]);
    const second = await upload();
    const { imports } = await invoker.run(useCases.listImports, admin, {});
    expect(imports.map((i) => i.id)).toEqual([second.id]);
    const stored = uow.store.tenants.get(TENANT)?.contentImports.get(second.id);
    expect(new TextDecoder().decode(stored?.source ?? undefined)).toBe('<wxr/>');
  });

  it('refuses a file that is no export, is not UTF-8, or is too large, and keeps nothing', async () => {
    const { invoker, admin, upload } = setup();
    await expectCode(upload('<html/>'), 'invalid_input', 'import.file.unreadable');
    await expectCode(
      invoker.run(useCases.uploadImport, admin, {
        fileName: 'export.xml',
        bytes: Buffer.from([0xff, 0xfe, 0x3c]).toString('base64'),
      }),
      'invalid_input',
      'import.file.unreadable'
    );
    await expectCode(
      upload('<wxr/>'.padEnd(25 * 1024 * 1024 + 1, ' ')),
      'invalid_input',
      'import.file.too-large'
    );
    expect((await invoker.run(useCases.listImports, admin, {})).imports).toEqual([]);
  });

  it('confirms a planned import into a job, once, and one import per site at a time', async () => {
    const { uow, invoker, admin, upload } = setup();
    const { id } = await upload();
    await expect(invoker.run(useCases.confirmImport, admin, { importId: id })).resolves.toEqual({
      id,
      status: 'queued',
    });
    expect(uow.store.jobs.map((j) => [j.type, j.key, j.payload])).toEqual([
      ['content.import', `content.import:${id}`, { importId: id }],
    ]);
    await expectCode(
      invoker.run(useCases.confirmImport, admin, { importId: id }),
      'conflict',
      'import.state.not-planned'
    );
    const next = await upload();
    await expectCode(
      invoker.run(useCases.confirmImport, admin, { importId: next.id }),
      'conflict',
      'import.state.busy'
    );
    await expectCode(
      invoker.run(useCases.deleteImport, admin, { importId: id }),
      'conflict',
      'import.state.busy'
    );
  });

  it('runs a queued import once, keeps its outcome and drops the file', async () => {
    const { uow, invoker, admin, upload, inTenant } = setup();
    const { id } = await upload();
    await invoker.run(useCases.confirmImport, admin, { importId: id });
    const claim = await inTenant<Awaited<ReturnType<typeof claimImport>>>((ctx) =>
      claimImport(ctx, id)
    );
    expect(claim).toMatchObject({ kind: 'start', xml: '<wxr/>', record: { status: 'running' } });
    const outcome = {
      items: [{ itemId: id, type: 'article', slug: 'a', status: 'published' as const }],
      lines: [],
      moreLines: 0,
    };
    await inTenant((ctx) => finishImport(ctx, id, { outcome }));
    const [done] = (await invoker.run(useCases.listImports, admin, {})).imports;
    expect(done).toMatchObject({ status: 'done', outcome, error: null });
    expect(uow.store.tenants.get(TENANT)?.contentImports.get(id)?.source).toBeNull();
    // The job again (a retry, a duplicate wake-up): nothing to do.
    expect(await inTenant((ctx) => claimImport(ctx, id))).toEqual({ kind: 'gone' });
    await invoker.run(useCases.deleteImport, admin, { importId: id });
    expect((await invoker.run(useCases.listImports, admin, {})).imports).toEqual([]);
  });

  it('fails an import whose run was interrupted instead of importing it twice', async () => {
    const { uow, invoker, admin, upload, inTenant } = setup();
    const { id } = await upload();
    await invoker.run(useCases.confirmImport, admin, { importId: id });
    await inTenant((ctx) => claimImport(ctx, id));
    expect(await inTenant((ctx) => claimImport(ctx, id))).toEqual({ kind: 'gone' });
    const [failed] = (await invoker.run(useCases.listImports, admin, {})).imports;
    expect(failed).toMatchObject({ status: 'failed', error: IMPORT_INTERRUPTED });
    expect(uow.store.tenants.get(TENANT)?.contentImports.get(id)?.source).toBeNull();
    // A finish that arrives after the failure changes nothing.
    await inTenant((ctx) => finishImport(ctx, id, { error: 'late' }));
    expect((await invoker.run(useCases.listImports, admin, {})).imports[0]?.error).toBe(
      IMPORT_INTERRUPTED
    );
  });

  it('is for tenant administrators only, and each site sees its own imports', async () => {
    const { invoker, upload } = setup();
    const editor = principal({ capabilities: ['content:write', 'content:publish', 'media:write'] });
    await expectCode(
      invoker.run(useCases.uploadImport, editor, { fileName: 'x.xml', bytes: b64('<wxr/>') }),
      'forbidden'
    );
    await expectCode(invoker.run(useCases.listImports, editor, {}), 'forbidden');
    await upload();
    const other = principal({ tenantId: '01890a5d-ac96-774b-bcce-b302099a8057' });
    expect((await invoker.run(useCases.listImports, other, {})).imports).toEqual([]);
  });

  it('keeps at most IMPORT_MAX_LINES remarks and counts the rest', () => {
    const lines = Array.from({ length: IMPORT_MAX_LINES + 2 }, () => ({ code: 'block.skipped' }));
    const kept = keptLines(lines);
    expect([kept.lines.length, kept.moreLines]).toEqual([IMPORT_MAX_LINES, 2]);
  });
});
