// The media picker's search (brief media-picker): a page of this site's images as JSON, found by
// filename or caption, for `static/_admin/media-picker.js`. The picker works without it; the
// server-rendered grid is the no-script path. Same use case and authorization as the media page.
import { json } from '@sveltejs/kit';
import { UseCaseError, useCases } from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { mediaChoice } from '#lib/server/media-choices.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 48;

export const GET: RequestHandler = async ({ locals, url, params }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const q = url.searchParams.get('q')?.trim().slice(0, 100) || undefined;
  const cursor = url.searchParams.get('cursor') ?? '';
  try {
    const list = await runtime().invoker.run(useCases.listMedia, principal, {
      kind: 'image',
      q,
      cursor: UUID.test(cursor) ? cursor : undefined,
      limit: PAGE,
    });
    return json(
      { items: list.items.map(mediaChoice), nextCursor: list.nextCursor },
      { headers: { 'cache-control': 'private, no-store' } }
    );
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'forbidden')
      return json({ items: [], nextCursor: null }, { status: 403 });
    throw e;
  }
};
