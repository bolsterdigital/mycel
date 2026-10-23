// The export download's answers (TODO #28, brief tenant-self-export § 4) over in-memory ports: a
// valid link streams the archive with attachment headers and writes one audit row; an old or
// altered link, A's link on B's admin, a member without `tenant:admin`, an operator without a
// membership (no principal: never a member, or removed since the link was made) and an archive
// that is not ready all get the same 404 and no audit row.
import { describe, expect, it } from 'vitest';
import {
  EXPORT_LINK_TTL_MS,
  Invoker,
  buildRegistry,
  exportArchiveKey,
  signExportDownload,
  systemPrincipal,
  useCases,
  type Principal,
} from '@mycel/core';
import { FakeClock, FakeSigner, MemoryUnitOfWork } from '@mycel/core/testing';
import { serveExportDownload } from './export-download.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';

async function setup() {
  const clock = new FakeClock();
  const signer = new FakeSigner();
  const uow = new MemoryUnitOfWork({ clock, signer });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = (tenant = TENANT): Principal => ({
    ...systemPrincipal(tenant, 'test'),
    actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-0000000000op' },
  });
  const { id } = await invoker.run(useCases.requestExport, admin(), {});
  const bytes = new TextEncoder().encode('archive bytes '.repeat(10_000));
  const row = uow.store.for(TENANT).exports.get(id)!;
  Object.assign(row, {
    status: 'ready',
    finishedAt: new Date(Date.UTC(2026, 9, 23)),
    sizeBytes: bytes.length,
    sha256: 'ab'.repeat(32),
    expiresAt: new Date(clock.now().getTime() + 7 * 24 * 3600 * 1000),
  });
  await uow.blobs.put(exportArchiveKey(TENANT, id), bytes, { contentType: 'application/x-tar' });
  const link = async (
    tenant = TENANT,
    at = new Date(clock.now().getTime() + EXPORT_LINK_TTL_MS)
  ) => {
    const { exp, sig } = await signExportDownload(signer, tenant, id, at);
    return `?exp=${exp}&sig=${encodeURIComponent(sig)}`;
  };
  const get = (principal: Principal | null, query: string, slug = 'probe', exportId = id) =>
    serveExportDownload(
      { uow, blobs: uow.blobs },
      principal,
      slug,
      exportId,
      new URL(`https://mycel.example/admin/${slug}/export/${exportId}${query}`)
    );
  const downloads = (tenant = TENANT) =>
    uow.store.for(tenant).audit.filter((a) => a.operation === 'tenant.export.download');
  return { uow, clock, id, bytes, admin, link, get, downloads };
}

describe('export download', () => {
  it('streams a ready archive for a valid link, as an attachment, and audits it', async () => {
    const { get, admin, link, bytes, downloads, id } = await setup();
    const res = await get(admin(), await link());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-tar');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="probe-2026-10-23.tar"'
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0]).toMatchObject({
      actorKind: 'operator',
      effect: 'export',
      subjectId: id,
      result: 'ok',
    });
  });

  it('answers 404 for an old link, an altered one, another site, a non-admin and a non-member', async () => {
    const { get, admin, link, clock, downloads } = await setup();
    const valid = await link();
    const editor: Principal = { ...admin(), capabilities: ['content:write', 'supporters:export'] };
    const responses = [
      await get(admin(), await link(TENANT, new Date(clock.now().getTime() - 1000))),
      await get(admin(), valid.replace(/sig=([^&]+)/, 'sig=$1x')),
      await get(admin(OTHER), valid, 'other'),
      await get(admin(OTHER), await link(OTHER), 'other'),
      await get(editor, valid),
      // No membership, never or no longer: the route gets no principal at all.
      await get(null, valid),
      await get(admin(), ''),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(downloads()).toEqual([]);
    expect(downloads(OTHER)).toEqual([]);
  });

  it('answers 404 once the archive has expired, even with a fresh link', async () => {
    const { get, admin, link, clock } = await setup();
    clock.advance(8 * 24 * 3600 * 1000);
    expect((await get(admin(), await link())).status).toBe(404);
  });
});
