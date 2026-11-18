// Who took part in a campaign as a CSV download (TODO MY-256 PR 2): the export button on the
// participants list posts here, `campaign.participation.export` decides and audits, and the answer
// is the file. A POST for the reasons `supporters/export` gives: taking addresses out is a command
// with an audit row, which a GET would run for a prefetch, and SvelteKit's origin check stops a
// cross-site form. The file starts with a byte order mark so a spreadsheet reads accents as UTF-8.
// The file name carries the campaign's id, not its title: a header takes no arbitrary text.
import { useCases } from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { PRIVATE_NO_STORE } from '#lib/server/http/http-cache.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, params }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const rt = runtime();
  const file = await loaded(
    rt.invoker.run(useCases.exportParticipations, principal, { campaignId: params.id })
  );
  const day = rt.clock.now().toISOString().slice(0, 10);
  const name = `participants-${params.tenant}-${params.id.slice(0, 8)}-${day}.csv`;
  return new Response(`﻿${file.csv}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': PRIVATE_NO_STORE,
      'x-content-type-options': 'nosniff',
    },
  });
};
