import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  isReservedPageSlug,
  appDelivery,
  buildRegistry,
  bytesToBase64,
  jobKey,
  purgeMedia,
  sweepMediaOrphans,
  systemPrincipal,
  useCases,
  verifyMediaSignature,
  type TransactionContext,
  type UnitOfWork,
} from '../index.js';
import { DEFAULT_ENTITLEMENTS } from '../entitlements/model.js';
import {
  FakeClock,
  FakeSigner,
  MemoryBlobStore,
  MemoryUnitOfWork,
  expectCode,
  TENANT,
} from '../testing/index.js';
import { MEDIA_PURGE_DELAY_MS } from './model.js';
import { EXAMPLE_PNG, ORPHAN_AGE_MS } from './service.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const system = systemPrincipal(TENANT, 'test');
const prefix = `tenants/${TENANT}/media/`;

/** The first 24 bytes of a PNG: enough for a probe to read its size. */
function pngHeader(width: number, height: number): string {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return bytesToBase64(b);
}
const text = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const JPEG = bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
const GIF = bytesToBase64(
  new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([40, 0, 20, 0]))
);

describe('media', () => {
  let clock: FakeClock;
  let blobs: MemoryBlobStore;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const upload = (
    input: Partial<Parameters<typeof useCases.uploadMedia.handler>[1]> = {},
    principal = system
  ) =>
    invoker.run(useCases.uploadMedia, principal, {
      filename: 'photo.png',
      contentType: 'image/png',
      bytes: pngHeader(1000, 500),
      ...input,
    });
  const keys = () => [...blobs.blobs.keys()].sort();

  beforeEach(() => {
    clock = new FakeClock();
    blobs = new MemoryBlobStore(clock);
    uow = new MemoryUnitOfWork({ clock, blobs });
    invoker = new Invoker(buildRegistry(), uow);
  });

  describe('upload', () => {
    it('stores a metadata-free original, AVIF and WebP up to its own width, and a thumbnail', async () => {
      const m = await upload({ filename: 'C:\\Users\\x\\photo.png' });
      expect(m).toMatchObject({
        kind: 'image',
        contentType: 'image/png',
        filename: 'photo.png',
        width: 1000,
        access: 'public',
        credit: { work: null, photographer: null },
        focal: { x: 0.5, y: 0.5 },
        state: 'ready',
        usageCount: 0,
      });
      expect(m.variants.map((v) => `${v.name}.${v.format}`)).toEqual([
        'w320.avif',
        'w320.webp',
        'w640.avif',
        'w640.webp',
        'w960.avif',
        'w960.webp',
        'w1000.avif',
        'w1000.webp',
        'thumb.webp',
      ]);
      expect(m.variants[0]!.path).toBe(`/media/${m.id}/w320.avif`);
      expect(keys()).toEqual(
        ['original.png', ...m.variants.map((v) => `${v.name}.${v.format}`)]
          .map((f) => `${prefix}${m.id}/${f}`)
          .sort()
      );
      expect(m.totalBytes).toBe([...blobs.blobs.values()].reduce((n, b) => n + b.bytes.length, 0));
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBe(24);
    });

    it('never upscales: a 3000 px image stops at w1920 and keeps its full size private', async () => {
      const m = await upload({ bytes: pngHeader(3000, 2000) });
      expect(m.variants.map((v) => v.name)).toEqual([
        'w320',
        'w320',
        'w640',
        'w640',
        'w960',
        'w960',
        'w1280',
        'w1280',
        'w1920',
        'w1920',
        'thumb',
      ]);
    });

    it('refuses SVG with its reason, and any type outside the allowlist', async () => {
      await expectCode(
        upload({ contentType: 'image/svg+xml', bytes: text('<svg/>') }),
        'invalid_input',
        'media.type.svg'
      );
      await expectCode(
        upload({ contentType: 'text/html', bytes: text('<p>') }),
        'invalid_input',
        'media.type.unsupported'
      );
    });

    it('refuses a file that is not what it claims to be', async () => {
      await expectCode(upload({ bytes: JPEG }), 'invalid_input', 'media.type.mismatch');
      await expectCode(
        upload({ bytes: text('not an image') }),
        'invalid_input',
        'media.type.unreadable'
      );
      await expectCode(
        upload({ contentType: 'application/pdf', bytes: pngHeader(1, 1) }),
        'invalid_input',
        'media.type.mismatch'
      );
      await expectCode(upload({ bytes: 'not base64!' }), 'invalid_input', 'media.bytes.base64');
    });

    it('refuses more than 50 megapixels before decoding anything', async () => {
      await expectCode(
        upload({ bytes: pngHeader(8000, 8000) }),
        'invalid_input',
        'media.pixels.too_many'
      );
      expect(keys()).toEqual([]);
    });

    it('counts every frame of an animation against the pixel limit', async () => {
      // 500x500 per frame, 201 frames: just over 50 MP together, a rendered roll of that size.
      const frames = 201;
      uow = new MemoryUnitOfWork({
        clock,
        blobs,
        images: {
          probe: async () => ({ format: 'gif', width: 500, height: 500, pages: frames }),
          render: async (bytes, { width }) => ({ bytes, width, height: width }),
        },
      });
      invoker = new Invoker(buildRegistry(), uow);
      await expectCode(
        upload({ filename: 'loop.gif', contentType: 'image/gif', bytes: GIF }),
        'invalid_input',
        'media.pixels.too_many'
      );
      expect(keys()).toEqual([]);
    });

    it('refuses more than 25 MB in the schema, before decoding', async () => {
      await expectCode(
        upload({ bytes: 'A'.repeat(35_000_000) }),
        'invalid_input',
        'media.size.too_large'
      );
    });

    it('stores a PDF as one delivered file and a GIF as its file plus a thumbnail', async () => {
      const pdf = await upload({
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: text('%PDF-1.7\n'),
      });
      expect(pdf).toMatchObject({ kind: 'document', width: null, height: null });
      expect(pdf.variants.map((v) => `${v.name}.${v.format}`)).toEqual(['file.pdf']);
      const gif = await upload({ filename: 'a.gif', contentType: 'image/gif', bytes: GIF });
      expect(gif.variants.map((v) => `${v.name}.${v.format}`)).toEqual(['file.gif', 'thumb.webp']);
      expect(keys().filter((k) => k.includes('original'))).toEqual([]);
    });

    it('stops at the storage cap: exactly at it is fine, one byte over is refused', async () => {
      const first = await upload();
      const total = first.totalBytes;
      const at = {
        ...system,
        entitlements: { ...DEFAULT_ENTITLEMENTS, 'media.storage_max_bytes': 2 * total },
      };
      await upload({}, at);
      await expectCode(
        upload({}, at),
        'limit_exceeded',
        'entitlements.limit.media.storage_max_bytes'
      );
      const usage = await invoker.run(useCases.getUsage, system, {});
      expect(usage.storage.usedBytes).toBe(2 * total);
    });

    it('takes the media lock before it counts the storage', async () => {
      const calls: string[] = [];
      const spy: UnitOfWork = {
        run: (p, fn) =>
          uow.run(p, (ctx) =>
            fn({
              ...ctx,
              media: { ...ctx.media, lock: async () => void calls.push('lock') },
              usage: { ...ctx.usage, storageBytes: async () => (calls.push('count'), 0) },
            } as TransactionContext)
          ),
      };
      await new Invoker(buildRegistry(), spy).run(useCases.uploadMedia, system, {
        filename: 'x.png',
        contentType: 'image/png',
        bytes: EXAMPLE_PNG,
      });
      expect(calls).toEqual(['lock', 'count']);
    });

    it('removes the files it wrote when a later write fails', async () => {
      let puts = 0;
      const failing = new MemoryBlobStore(clock);
      const put = failing.put.bind(failing);
      failing.put = async (...args) => {
        if (++puts === 3) throw new Error('disk full');
        return put(...args);
      };
      const u = new MemoryUnitOfWork({ clock, blobs: failing });
      await expect(
        new Invoker(buildRegistry(), u).run(useCases.uploadMedia, system, {
          filename: 'x.png',
          contentType: 'image/png',
          bytes: pngHeader(1000, 500),
        })
      ).rejects.toThrow('disk full');
      expect(failing.blobs.size).toBe(0);
      expect(u.store.for(TENANT).media.size).toBe(0);
    });
  });

  describe('read, update and access', () => {
    it('updates the editorial fields and never the file', async () => {
      const m = await upload();
      clock.advance(1000);
      const u = await invoker.run(useCases.updateMedia, system, {
        id: m.id,
        caption: { nl: 'Bijschrift' },
        credit: { work: { title: 'Guernica', maker: 'Picasso' }, photographer: 'A. Fotograaf' },
        licence: 'CC BY 4.0',
        focal: { x: 0.2, y: 0.8 },
      });
      expect(u).toMatchObject({
        caption: { nl: 'Bijschrift' },
        licence: 'CC BY 4.0',
        checksum: m.checksum,
      });
      expect(u.updatedAt).not.toBe(m.updatedAt);
    });

    it('gives a restricted asset no public path', async () => {
      const m = await upload({ access: 'restricted' });
      expect(m.variants.every((v) => v.path === '')).toBe(true);
      const again = await invoker.run(useCases.updateMedia, system, { id: m.id, access: 'public' });
      expect(again.variants[0]!.path).toBe(`/media/${m.id}/w320.avif`);
    });

    it('lists newest first, a page at a time, and only this tenant', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await upload()).id);
        clock.advance(1000);
      }
      await upload({}, systemPrincipal(OTHER, 'test'));
      const first = await invoker.run(useCases.listMedia, system, { limit: 2 });
      expect(first.items.map((m) => m.id)).toEqual([ids[2], ids[1]]);
      const second = await invoker.run(useCases.listMedia, system, {
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second).toMatchObject({ items: [{ id: ids[0] }], nextCursor: null });
      await expectCode(
        invoker.run(useCases.getMedia, systemPrincipal(OTHER, 'x'), { id: ids[0]! }),
        'not_found'
      );
    });

    it('finds a filename or a caption in any locale, case-insensitive, with % taken literally', async () => {
      const beach = await upload({ filename: 'Beach_2026.png' });
      const crowd = await upload({ filename: 'crowd.png' });
      await invoker.run(useCases.updateMedia, system, {
        id: crowd.id,
        caption: { en: 'Protest on the Dam', nl: 'Demonstratie 100% vol' },
      });
      await upload({ filename: 'other.png' });
      const ids = async (q: string) =>
        (await invoker.run(useCases.listMedia, system, { q })).items.map((m) => m.id);
      expect(await ids('beach')).toEqual([beach.id]);
      expect(await ids('DAM')).toEqual([crowd.id]);
      expect(await ids('100%')).toEqual([crowd.id]);
      expect(await ids('h_2')).toEqual([beach.id]);
      expect(await ids('nothing')).toEqual([]);
    });

    it('needs media:read to read and media:write to upload', async () => {
      const reader = {
        ...system,
        actor: { kind: 'api-key' as const, keyId: 'k' },
        capabilities: ['media:read' as const],
      };
      await expectCode(upload({}, reader), 'forbidden');
      expect((await invoker.run(useCases.listMedia, reader, {})).items).toEqual([]);
    });
  });

  describe('delete and purge', () => {
    it('refuses while usages exist, naming only how many', async () => {
      const m = await upload();
      await uow.run(system, (ctx) =>
        ctx.media.replaceUsages('item:1:rev:1', [
          { mediaId: m.id, blockId: 'b1' },
          { mediaId: m.id, blockId: 'b2' },
        ])
      );
      await expect(invoker.run(useCases.deleteMedia, system, { id: m.id })).rejects.toThrow(
        'in use in 2 place(s)'
      );
      await uow.run(system, (ctx) => ctx.media.replaceUsages('item:1:rev:1', []));
      expect(await invoker.run(useCases.deleteMedia, system, { id: m.id })).toEqual({
        id: m.id,
        purgeScheduled: true,
      });
      await expectCode(invoker.run(useCases.getMedia, system, { id: m.id }), 'not_found');
    });

    it('plans the purge in the same transaction, and the purge removes files and row', async () => {
      const m = await upload();
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      const job = uow.store.jobs.find((j) => j.key === jobKey('media.purge', m.id))!;
      expect(job).toMatchObject({ tenantId: TENANT, type: 'media.purge' });
      // TODO #29A: not before a backup or export that holds the row has copied the files.
      expect(job.runAt).toEqual(new Date(clock.now().getTime() + MEDIA_PURGE_DELAY_MS));
      const payload = job.payload as { mediaId: string; keys: string[] };
      expect(payload.keys.sort()).toEqual(keys());
      // A deleted asset no longer counts against the cap, even before the purge.
      expect((await invoker.run(useCases.getUsage, system, {})).storage.usedBytes).toBe(0);
      await uow.run(system, (ctx) => purgeMedia(ctx, payload));
      expect(keys()).toEqual([]);
      expect(uow.store.for(TENANT).media.size).toBe(0);
      // Idempotent: a second run finds nothing to do.
      await uow.run(system, (ctx) => purgeMedia(ctx, payload));
    });

    it('purges only keys of its own asset', async () => {
      const m = await upload();
      await expect(
        uow.run(system, (ctx) =>
          purgeMedia(ctx, { mediaId: m.id, keys: [`tenants/${OTHER}/media/${m.id}/w320.avif`] })
        )
      ).rejects.toThrow('keys outside');
    });

    it('sweeps orphans older than a day and keeps young ones and files with a row', async () => {
      const m = await upload();
      await blobs.put(
        `${prefix}01900000-0000-7000-8000-0000000000ff/original.png`,
        new Uint8Array(3),
        { contentType: 'image/png' }
      );
      clock.advance(ORPHAN_AGE_MS + 1);
      await blobs.put(
        `${prefix}01900000-0000-7000-8000-0000000000fe/original.png`,
        new Uint8Array(3),
        { contentType: 'image/png' }
      );
      await blobs.put(
        `tenants/${OTHER}/media/01900000-0000-7000-8000-0000000000fd/x.png`,
        new Uint8Array(3),
        { contentType: 'image/png' }
      );
      clock.advance(1);
      const swept = await uow.run(system, (ctx) => sweepMediaOrphans(ctx));
      expect(swept).toEqual([`${prefix}01900000-0000-7000-8000-0000000000ff/original.png`]);
      expect(keys().filter((k) => k.includes(m.id))).toHaveLength(10);
      expect(keys()).toContain(`tenants/${OTHER}/media/01900000-0000-7000-8000-0000000000fd/x.png`);
    });
  });

  describe('delivery', () => {
    const signer = new FakeSigner();
    const id = '01900000-0000-7000-8000-00000000d001';
    const now = new Date('2026-10-22T12:00:00Z');

    it('builds a site path and a signed path that opens one file until it expires', async () => {
      expect(appDelivery.variantPath(id, 'w960.avif')).toBe(`/media/${id}/w960.avif`);
      const signed = await appDelivery.signedVariantPath(
        signer,
        id,
        'w960.avif',
        new Date(+now + 600_000)
      );
      const url = new URL(signed, 'https://site.example');
      expect(url.pathname).toBe(`/media/${id}/w960.avif`);
      const [exp, sig] = [url.searchParams.get('exp'), url.searchParams.get('sig')];
      expect(await verifyMediaSignature(signer, id, 'w960.avif', exp, sig, now)).toBe(true);
      expect(await verifyMediaSignature(signer, id, 'w960.webp', exp, sig, now)).toBe(false);
      expect(
        await verifyMediaSignature(signer, id, 'w960.avif', String(Number(exp) + 1), sig, now)
      ).toBe(false);
      expect(
        await verifyMediaSignature(signer, id, 'w960.avif', exp, sig, new Date(+now + 600_001))
      ).toBe(false);
      expect(await verifyMediaSignature(signer, id, 'w960.avif', null, sig, now)).toBe(false);
    });

    it('reserves `media` as a page slug', () => {
      expect(isReservedPageSlug('media')).toBe(true);
      expect(isReservedPageSlug('mediatheek')).toBe(false);
    });
  });
});
