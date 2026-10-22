// Media over HTTP (TODO #10): the base64 JSON body is the contract an integration and an agent
// share, so an upload, a read, the capability check and the size limits are proven here once.
// The registry conformance already covers the generic shapes (400, 403, OpenAPI) of every
// operation; this file keeps what is specific to a file in a JSON body.

import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PNG,
  Invoker,
  MAX_UPLOAD_BYTES,
  buildRegistry,
  systemPrincipal,
  type Principal,
} from '@mycel/core';
import { MemoryUnitOfWork } from '@mycel/core/testing';
import { MAX_BODY_BYTES, createApp } from './app.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';

function setup() {
  const uow = new MemoryUnitOfWork();
  const keys: Record<string, Principal> = {
    admin: systemPrincipal(TENANT, 'api'),
    reader: { ...systemPrincipal(TENANT, 'api'), capabilities: ['media:read'] },
    content: { ...systemPrincipal(TENANT, 'api'), capabilities: ['content:read'] },
  };
  const app = createApp({
    invoker: new Invoker(buildRegistry(), uow),
    authenticate: async (h) => keys[h?.replace('Bearer ', '') ?? ''] ?? null,
  });
  const post = (name: string, body: unknown, key = 'admin') =>
    app.request(`/v1/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, post, uow };
}

describe('media over HTTP', () => {
  it('uploads as JSON with base64, then reads it back by POST and GET', async () => {
    const { app, post, uow } = setup();
    const res = await post('media.upload', {
      filename: 'pixel.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
      credit: { work: null, photographer: 'A. Fotograaf' },
    });
    expect(res.status).toBe(200);
    const media = (await res.json()) as { id: string; variants: { path: string }[] };
    expect(media.variants.map((v) => v.path)).toContain(`/media/${media.id}/thumb.webp`);
    expect([...(await keysOf(uow))].every((k) => k.startsWith(`tenants/${TENANT}/media/`))).toBe(
      true
    );

    const read = await post('media.get', { id: media.id }, 'reader');
    expect(await read.json()).toMatchObject({
      id: media.id,
      credit: { photographer: 'A. Fotograaf' },
    });
    const listed = await app.request('/v1/media.list?limit=10', {
      headers: { authorization: 'Bearer reader' },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: media.id }], nextCursor: null });
  });

  it('refuses without media:read, and an upload without media:write', async () => {
    const { post } = setup();
    expect((await post('media.list', {}, 'content')).status).toBe(403);
    const upload = await post(
      'media.upload',
      { filename: 'p.png', contentType: 'image/png', bytes: EXAMPLE_PNG },
      'reader'
    );
    expect(upload.status).toBe(403);
  });

  it('refuses SVG and a lie about the type as invalid input', async () => {
    const { post } = setup();
    const svg = await post('media.upload', {
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      bytes: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    expect(svg.status).toBe(400);
    expect(await svg.json()).toMatchObject({ issues: [{ message: 'media.type.svg' }] });
    const lie = await post('media.upload', {
      filename: 'x.jpg',
      contentType: 'image/jpeg',
      bytes: EXAMPLE_PNG,
    });
    expect(await lie.json()).toMatchObject({ issues: [{ message: 'media.type.mismatch' }] });
  });

  it('refuses a file over 25 MB in the schema, and a body over the limit with 413', async () => {
    const { post } = setup();
    const over = 'A'.repeat(Math.ceil((MAX_UPLOAD_BYTES + 3) / 3) * 4);
    const big = await post('media.upload', {
      filename: 'big.png',
      contentType: 'image/png',
      bytes: over,
    });
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ issues: [{ message: 'media.size.too_large' }] });

    const huge = await post('media.upload', `{"bytes":"${'A'.repeat(MAX_BODY_BYTES)}"}`);
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: 'payload_too_large' });
  });
});

async function keysOf(uow: MemoryUnitOfWork): Promise<string[]> {
  const out: string[] = [];
  for await (const b of uow.blobs.list('')) out.push(b.key);
  return out;
}
