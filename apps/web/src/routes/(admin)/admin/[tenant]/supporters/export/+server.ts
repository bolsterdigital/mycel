// The Supporters list as a CSV download (TODO MY-256 PR 1): the export button on the list posts
// the filter in view here, `supporter.export` decides and audits, and the answer is the file. A
// POST, not a link, because taking supporters out is a command with an audit row: a GET would run
// it for a prefetch or a crawler, and a cross-site form is stopped by SvelteKit's origin check.
// No JavaScript needed: the browser saves an attachment and stays on the list. The file starts
// with a byte order mark so a spreadsheet reads accents as UTF-8. Rejected: the CSV built here
// from `supporter.list` pages (it would need only `supporters:read`, ADR 018 rule 5) and a
// redirect to a stored file (one list fits a response; nothing to clean up afterwards).
import { useCases } from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { PRIVATE_NO_STORE } from '#lib/server/http/http-cache.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

const field = (data: FormData, name: string, max: number) => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
};

export const POST: RequestHandler = async ({ locals, url, params, request }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const data = await request.formData();
  const q = field(data, 'q', 254);
  const list = field(data, 'list', 100);
  const asked = field(data, 'status', 10);
  const status = list && (asked === 'confirmed' || asked === 'pending') ? asked : '';
  const rt = runtime();
  const file = await loaded(
    rt.invoker.run(useCases.exportSupporters, principal, {
      ...(q ? { q } : {}),
      ...(list ? { list } : {}),
      ...(status ? { status } : {}),
    })
  );
  const day = rt.clock.now().toISOString().slice(0, 10);
  return new Response(`﻿${file.csv}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="supporters-${params.tenant}-${day}.csv"`,
      'cache-control': PRIVATE_NO_STORE,
      'x-content-type-options': 'nosniff',
    },
  });
};
