// The import page of a site (MY-257 PR 3, brief wordpress-import-execution § PR 3): upload a
// WordPress export and see the dry run, start it, follow it by reloading, and see what it made.
// Every step is a native form post to the same use cases HTTP and MCP expose
// (`content.import.upload|confirm|delete|list`), all `tenant:admin`. The upload is a multipart
// form whose action turns the file into base64, as the media page does, within the body ceiling
// `body-limit.ts` raises for this action only. Nothing polls: a reload shows the progress, as on
// the export page. Rejected: a client-side upload with progress (a second contract, and the
// file is small next to its run) and a separate page per import (one site has a handful).
import { fail } from '@sveltejs/kit';
import { useCases } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const { imports } = await loaded(runtime().invoker.run(useCases.listImports, principal, {}));
  return { imports, now: runtime().clock.now().toISOString(), defaultLocale: tenant.defaultLocale };
};

const copy = {
  conflict: 'admin.import.error.busy',
  invalid: 'admin.import.error.unreadable',
  issues: {
    'import.file.unreadable': 'admin.import.error.unreadable',
    'import.file.too-large': 'admin.import.error.tooLarge',
    'import.file.empty': 'admin.import.error.noFile',
    'import.state.busy': 'admin.import.error.busy',
    'import.state.not-planned': 'admin.import.error.notPlanned',
  },
} as const;

export const actions: Actions = {
  upload: async (event) => {
    // The items go into this site, so its default language is theirs; an export's channel often
    // says `en-US` whatever the site is written in. The CLI keeps `--default-locale` for the rest.
    const tenant = await runtime().tenants.findBySlug(event.params.tenant);
    return act(event, 'upload', copy, async (principal, data) => {
      const file = data.get('file');
      if (!(file instanceof File) || file.size === 0)
        return fail(400, { action: 'upload', error: 'admin.import.error.noFile' as const });
      await runtime().invoker.run(useCases.uploadImport, principal, {
        fileName: file.name.slice(0, 200) || 'export.xml',
        bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
        ...(tenant?.defaultLocale && { defaultLocale: tenant.defaultLocale }),
        intoExisting: text(data, 'intoExisting') === 'on',
      });
      return { action: 'upload', done: 'admin.import.done.uploaded' as const };
    });
  },
  confirm: (event) =>
    act(event, 'confirm', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.confirmImport, principal, {
        importId: text(data, 'id'),
      });
      return { action: 'confirm', done: 'admin.import.done.confirmed' as const };
    }),
  delete: (event) =>
    act(event, 'delete', copy, async (principal, data) => {
      await runtime().invoker.run(useCases.deleteImport, principal, { importId: text(data, 'id') });
      return { action: 'delete', done: 'admin.import.done.deleted' as const };
    }),
};
