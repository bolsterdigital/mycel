// The export page of a site (TODO #28, brief tenant-self-export § 6): ask for an archive of the
// whole site, see earlier ones, and download a ready one through a link signed for five minutes
// (`/admin/<site>/export/<id>`, lib/server/export-download.ts). Asking is a native form post to the
// same `tenant.export` command HTTP and MCP expose; it works while the site is suspended, and a
// second ask while one is being built gets that one back. A reload shows the progress; nothing
// polls. Rejected: links signed for longer than a page view, which would outlive the session.
import { EXPORT_LINK_TTL_MS, can, signExportDownload, useCases } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { act } from '#lib/server/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'tenant:admin')) error(403, 'tenant:admin');
  const rt = runtime();
  const { exports } = await rt.invoker.run(useCases.listExports, principal, {});
  const until = new Date(rt.clock.now().getTime() + EXPORT_LINK_TTL_MS);
  return {
    retentionDays: rt.config.EXPORT_RETENTION_DAYS,
    exports: await Promise.all(
      exports.map(async (e) => {
        if (e.status !== 'ready') return { ...e, href: null };
        const { exp, sig } = await signExportDownload(rt.signer, principal.tenantId, e.id, until);
        const query = new URLSearchParams({ exp: String(exp), sig });
        return { ...e, href: `/admin/${params.tenant}/export/${e.id}?${query}` };
      })
    ),
  };
};

export const actions: Actions = {
  request: (event) =>
    act(event, 'request', { conflict: 'admin.error.invalid' }, async (principal) => {
      const { created } = await runtime().invoker.run(useCases.requestExport, principal, {});
      return {
        action: 'request',
        done: (created ? 'admin.export.done.requested' : 'admin.export.done.running') as UiKey,
      };
    }),
};
