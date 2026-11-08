import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  isReservedPageSlug,
  appDelivery,
  buildRegistry,
  bytesToBase64,
  purgeMedia,
  sweepMediaOrphans,
  systemPrincipal,
  useCases,
  verifyMediaSignature,
  type TransactionContext,
  type UnitOfWork,
} from '../index.js';
import {
  FakeClock,
  FakeSigner,
  MemoryBlobStore,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import {
  FORMAT_OF,
  MEDIA_PURGE_DELAY_MS,
  MEDIA_TRASH_RETENTION_MS,
  VARIANT_MAX_STEP,
  VARIANT_WIDTHS,
  variantWidths,
} from './model.js';
import { EXAMPLE_PNG, ORPHAN_AGE_MS, uploadMedia } from './service.js';

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

  describe('variant ladder', () => {
    it('never steps more than VARIANT_MAX_STEP from 640 up, so a browser overshoots by at most that', () => {
      const from = VARIANT_WIDTHS.indexOf(640);
      for (let i = from + 1; i < VARIANT_WIDTHS.length; i++)
        expect(VARIANT_WIDTHS[i]! / VARIANT_WIDTHS[i - 1]!).toBeLessThanOrEqual(VARIANT_MAX_STEP);
    });

    it('adds the own width only when it gains enough over the step below, and never upscales', () => {
      expect(variantWidths(1200)).toEqual([320, 480, 640, 800, 960, 1080, 1200]);
      expect(variantWidths(1080)).toEqual([320, 480, 640, 800, 960, 1080]);
      expect(variantWidths(4000)).toEqual([...VARIANT_WIDTHS]);
      expect(variantWidths(200)).toEqual([200]);
      expect(variantWidths(1282)).toEqual([320, 480, 640, 800, 960, 1080, 1280]);
      expect(variantWidths(1000)).toEqual([320, 480, 640, 800, 960]);
    });
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
        'w480.avif',
        'w480.webp',
        'w640.avif',
        'w640.webp',
        'w800.avif',
        'w800.webp',
        'w960.avif',
        'w960.webp',
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
        ...VARIANT_WIDTHS.flatMap((w) => [`w${w}`, `w${w}`]),
        'thumb',
      ]);
      expect(m.variants.at(-2)!.width).toBe(1920);
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
        'media.pixels.too-many'
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
        'media.pixels.too-many'
      );
      expect(keys()).toEqual([]);
    });

    it('refuses more than 25 MB in the schema, before decoding', async () => {
      await expectCode(
        upload({ bytes: 'A'.repeat(35_000_000) }),
        'invalid_input',
        'media.size.too-large'
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

    // `contentType` is a free string, so this sentence is how an agent learns what can be uploaded.
    it('names every accepted format in the description of media.upload', () => {
      for (const format of Object.values(FORMAT_OF))
        expect(uploadMedia.description.toLowerCase()).toContain(format);
    });

    it('stores an MP3 as one delivered file and refuses what only claims to be one', async () => {
      const frame = bytesToBase64(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]));
      const mp3 = await upload({ filename: 'a.mp3', contentType: 'audio/mpeg', bytes: frame });
      expect(mp3).toMatchObject({ kind: 'audio', width: null, height: null });
      expect(mp3.variants.map((v) => `${v.name}.${v.format}`)).toEqual(['file.mp3']);
      const tagged = await upload({
        filename: 'b.mp3',
        contentType: 'audio/mpeg',
        bytes: text('ID3\x04\0\0'),
      });
      expect(tagged.kind).toBe('audio');
      for (const bytes of [
        text('%PDF-1.7\n'),
        text('<script>alert(1)</script>'),
        // A sync word with a reserved version, a layer other than III, a bad bitrate, a bad rate.
        bytesToBase64(new Uint8Array([0xff, 0xeb, 0x90, 0x64])),
        bytesToBase64(new Uint8Array([0xff, 0xfd, 0x90, 0x64])),
        bytesToBase64(new Uint8Array([0xff, 0xfb, 0xf0, 0x64])),
        bytesToBase64(new Uint8Array([0xff, 0xfb, 0x9c, 0x64])),
      ])
        await expectCode(
          upload({ filename: 'c.mp3', contentType: 'audio/mpeg', bytes }),
          'invalid_input',
          'media.type.mismatch'
        );
    });

    it('stops at the storage cap: exactly at it is fine, one byte over is refused', async () => {
      const first = await upload();
      const total = first.totalBytes;
      const at = principal({ entitlements: { 'media.storage_max_bytes': 2 * total } });
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
      const reader = principal({
        actor: { kind: 'api-key', keyId: 'k' },
        capabilities: ['media:read'],
      });
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
        restorableUntil: new Date(clock.now().getTime() + MEDIA_TRASH_RETENTION_MS).toISOString(),
      });
      await expectCode(invoker.run(useCases.getMedia, system, { id: m.id }), 'not_found');
    });

    it('a purge job from before the trash removes files and row, and is idempotent', async () => {
      const m = await upload();
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      const payload = { mediaId: m.id, keys: keys() };
      // A deleted asset no longer counts against the cap, even before the purge.
      expect((await invoker.run(useCases.getUsage, system, {})).storage.usedBytes).toBe(0);
      await uow.run(system, (ctx) => purgeMedia(ctx, payload));
      expect(keys()).toEqual([]);
      expect(uow.store.for(TENANT).media.size).toBe(0);
      await uow.run(system, (ctx) => purgeMedia(ctx, payload));
    });

    it('never takes the files of an asset restored after the job was planned', async () => {
      const m = await upload();
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      const payload = { mediaId: m.id, keys: keys() };
      await invoker.run(useCases.restoreMedia, system, { ids: [m.id] });
      await uow.run(system, (ctx) => purgeMedia(ctx, payload));
      expect(keys()).toEqual(payload.keys);
      await invoker.run(useCases.getMedia, system, { id: m.id });
    });

    it('keeps the trash at least as long as a backup needs', () => {
      expect(MEDIA_TRASH_RETENTION_MS).toBeGreaterThanOrEqual(MEDIA_PURGE_DELAY_MS);
    });

    it('moves many to the trash with a result per item, and a retry is safe', async () => {
      const [free, used] = [await upload(), await upload()];
      await uow.run(system, (ctx) =>
        ctx.media.replaceUsages('item:1:rev:1', [{ mediaId: used.id, blockId: 'b1' }])
      );
      const gone = '00000000-0000-4000-8000-00000000dead';
      const ids = [free.id, used.id, gone];
      const first = await invoker.run(useCases.bulkDeleteMedia, system, { ids });
      expect(first.results.map((r) => r.status)).toEqual(['deleted', 'in-use', 'not-found']);
      expect(first.results[1]).toMatchObject({ usageCount: 1 });
      const again = await invoker.run(useCases.bulkDeleteMedia, system, { ids });
      expect(again.results.map((r) => r.status)).toEqual(['deleted', 'in-use', 'not-found']);
      expect(again.results[0]!.restorableUntil).toBe(first.results[0]!.restorableUntil);
      await expectCode(invoker.run(useCases.getMedia, system, { id: free.id }), 'not_found');
      const trash = await invoker.run(useCases.listMediaTrash, system, {});
      expect(trash).toMatchObject({ total: 1, items: [{ id: free.id, filename: free.filename }] });
    });

    it('restores within the window and refuses after it, and the sweep then removes the files', async () => {
      const m = await upload();
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      clock.advance(MEDIA_TRASH_RETENTION_MS - 1);
      await uow.run(system, (ctx) => sweepMediaOrphans(ctx));
      expect(keys().length).toBeGreaterThan(0);
      const back = await invoker.run(useCases.restoreMedia, system, { ids: [m.id] });
      expect(back.results).toEqual([{ id: m.id, status: 'restored' }]);
      expect(await invoker.run(useCases.getMedia, system, { id: m.id })).toMatchObject({
        id: m.id,
      });
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      clock.advance(MEDIA_TRASH_RETENTION_MS);
      expect((await invoker.run(useCases.listMediaTrash, system, {})).total).toBe(0);
      const late = await invoker.run(useCases.restoreMedia, system, { ids: [m.id] });
      expect(late.results).toEqual([{ id: m.id, status: 'expired' }]);
      await uow.run(system, (ctx) => sweepMediaOrphans(ctx));
      expect(keys()).toEqual([]);
      expect(uow.store.for(TENANT).media.size).toBe(0);
    });

    it('does not restore past the storage limit', async () => {
      const m = await upload();
      await invoker.run(useCases.deleteMedia, system, { id: m.id });
      const low = principal({ entitlements: { 'media.storage_max_bytes': 1 } });
      const refused = await invoker.run(useCases.restoreMedia, low, { ids: [m.id] });
      expect(refused.results).toEqual([{ id: m.id, status: 'over-limit' }]);
    });

    it('asks media:write for the trash and its actions', async () => {
      const reader = principal({ capabilities: ['media:read'] });
      const id = '00000000-0000-4000-8000-00000000dead';
      await expectCode(invoker.run(useCases.listMediaTrash, reader, {}), 'forbidden');
      await expectCode(invoker.run(useCases.restoreMedia, reader, { ids: [id] }), 'forbidden');
      await expectCode(invoker.run(useCases.bulkDeleteMedia, reader, { ids: [id] }), 'forbidden');
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
      expect(keys().filter((k) => k.includes(m.id))).toHaveLength(1 + m.variants.length);
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
