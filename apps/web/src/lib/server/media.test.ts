// The delivery route's answers (TODO #10, brief decision 8) over in-memory ports: headers of a
// public variant, 304 on a matching ETag, 403 for a restricted asset without a signature and 200
// with one, 404 for the original, an unknown file or another site's asset.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS,
  EXAMPLE_PNG,
  Invoker,
  appDelivery,
  buildRegistry,
  bytesToBase64,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeClock, FakeSigner, MemoryUnitOfWork } from '@mycel/core/testing';
import { serveMedia } from './media.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const site = (id: string) => ({ id, ...DEFAULT_ACCESS });

async function setup() {
  const clock = new FakeClock();
  const signer = new FakeSigner();
  const uow = new MemoryUnitOfWork({ clock, signer });
  const invoker = new Invoker(buildRegistry(), uow);
  const upload = (input: Record<string, unknown> = {}) =>
    invoker.run(useCases.uploadMedia, systemPrincipal(TENANT, 'test'), {
      filename: 'pixel.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
      ...input,
    });
  const deps = { uow, blobs: uow.blobs, signer, clock };
  const get = (id: string, file: string, query = '', tenant = TENANT, etag: string | null = null) =>
    serveMedia(
      deps,
      site(tenant),
      id,
      file,
      new URL(`https://probe.example/media/${id}/${file}${query}`),
      etag
    );
  const remove = (id: string) =>
    invoker.run(useCases.deleteMedia, systemPrincipal(TENANT, 'test'), { id });
  return { upload, get, remove, signer, clock };
}

describe('media delivery route', () => {
  it('serves a public variant with immutable caching and its ETag', async () => {
    const { upload, get } = await setup();
    const m = await upload();
    const res = await get(m.id, 'w1.webp');
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      etag: `"${m.checksum}:w1.webp"`,
      'content-length': String((await res.clone().arrayBuffer()).byteLength),
    });
    expect(bytesToBase64(new Uint8Array(await res.arrayBuffer()))).toBe(EXAMPLE_PNG);
    expect((await get(m.id, 'w1.webp', '', TENANT, `"${m.checksum}:w1.webp"`)).status).toBe(304);
  });

  it('never serves the original, an unknown file or another site’s asset', async () => {
    const { upload, get, signer, clock } = await setup();
    const m = await upload();
    expect((await get(m.id, 'original.png')).status).toBe(404);
    const signed = await appDelivery.signedVariantPath(
      signer,
      m.id,
      'original.png',
      new Date(+clock.now() + 60_000)
    );
    expect((await get(m.id, 'original.png', signed.slice(signed.indexOf('?')))).status).toBe(404);
    expect((await get(m.id, 'w9999.avif')).status).toBe(404);
    expect((await get(m.id, '..%2Foriginal.png')).status).toBe(404);
    expect((await get('not-a-uuid', 'w1.webp')).status).toBe(404);
    expect((await get(m.id, 'w1.webp', '', OTHER)).status).toBe(404);
  });

  it('opens a restricted asset only with a valid, unexpired signature, never to a shared cache', async () => {
    const { upload, get, signer, clock } = await setup();
    const m = await upload({ access: 'restricted' });
    const denied = await get(m.id, 'w1.avif');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');

    const path = await appDelivery.signedVariantPath(
      signer,
      m.id,
      'w1.avif',
      new Date(+clock.now() + 600_000)
    );
    const query = path.slice(path.indexOf('?'));
    const ok = await get(m.id, 'w1.avif', query);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    // The signature is for one file, and it expires.
    expect((await get(m.id, 'w1.webp', query)).status).toBe(403);
    clock.advance(600_001);
    expect((await get(m.id, 'w1.avif', query)).status).toBe(403);
  });

  it('serves a PDF inline under its own name', async () => {
    const { upload, get } = await setup();
    const m = await upload({
      filename: 'jaarverslag 2026 – définitief.pdf',
      contentType: 'application/pdf',
      bytes: btoa('%PDF-1.7\n%%EOF'),
    });
    const res = await get(m.id, 'file.pdf');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="jaarverslag 2026 _ d_finitief.pdf"; filename*=UTF-8''${encodeURIComponent('jaarverslag 2026 – définitief.pdf')}`
    );
  });

  it('answers 404 once the asset is deleted, before the purge has run', async () => {
    const { upload, get, remove } = await setup();
    const m = await upload();
    expect((await get(m.id, 'thumb.webp')).status).toBe(200);
    await remove(m.id);
    expect((await get(m.id, 'thumb.webp')).status).toBe(404);
  });
});
