// The file itself uploads directly. This page holds the site's metadata, settings and status.
import { can, LICENCE_CODES, MAX_PAGE_SIZE, useCases } from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { langOf } from '../../../../../../i18n/index.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const write = can(principal, 'media:write');
  const [videos, bound, media] = await Promise.all([
    loaded(rt.invoker.run(useCases.listVideos, principal, {})),
    rt.uow.run(principal, async (ctx) => !!ctx.videoProvider),
    write
      ? rt.invoker.run(useCases.listMedia, principal, { kind: 'image', limit: MAX_PAGE_SIZE })
      : null,
  ]);
  locals.videoUploadPage = write && bound;
  return {
    tenant,
    locale: langOf(locals),
    videos,
    canUpload: write && bound,
    canWrite: write,
    licences: LICENCE_CODES.filter((code) => code !== 'other'),
    posters: (media?.items ?? [])
      .filter((image) => image.access === 'public' && image.state === 'ready')
      .map((image) => ({ value: image.id, label: image.filename })),
  };
};

export const actions: Actions = {
  check: async ({ locals, url, params, request }) => {
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    try {
      await runtime().invoker.run(useCases.checkVideo, principal, {
        id: text(await request.formData(), 'id'),
      });
      return { ok: true };
    } catch (e) {
      refusalOf(e);
      return fail(409, { ok: false });
    }
  },
  trash: async ({ locals, url, params, request }) => {
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    try {
      await runtime().invoker.run(useCases.deleteVideo, principal, {
        id: text(await request.formData(), 'id'),
      });
      return { ok: true };
    } catch (e) {
      refusalOf(e);
      return fail(409, { ok: false });
    }
  },
};
