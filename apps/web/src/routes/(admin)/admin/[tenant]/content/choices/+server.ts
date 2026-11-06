// The button target's search (TargetPicker): pages and articles of this site as JSON, found by a
// title or the slug, for `static/_admin/target-picker.js`. The block form's select already holds
// the newest hundred; this route finds the older ones. The field works without it, and without
// JavaScript the select plus address field is the whole path. Same use case and authorization as
// the content list. Rejected: a second list use case for pickers (the list already searches).
import { json } from '@sveltejs/kit';
import { useCases } from '@mycel/core';
import { refusalOf } from '#lib/server/http/refuse.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { itemLabel } from '#lib/server/content/content-blocks.js';
import { PRIVATE_NO_STORE } from '#lib/server/http/http-cache.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const PAGE = 20;

export const GET: RequestHandler = async ({ locals, url, params }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const q = url.searchParams.get('q')?.replaceAll('\0', '').trim().slice(0, 100) || undefined;
  const locale = url.searchParams.get('locale')?.slice(0, 35) ?? '';
  const headers = { 'cache-control': PRIVATE_NO_STORE };
  if (!q) return json({ items: [] }, { headers });
  try {
    const list = await runtime().invoker.run(useCases.listItems, principal, { q, limit: PAGE });
    return json(
      { items: list.items.map((i) => ({ id: i.id, label: itemLabel(i, locale) })) },
      { headers }
    );
  } catch (e) {
    if (refusalOf(e).code === 'forbidden') return json({ items: [] }, { status: 403, headers });
    throw e;
  }
};
