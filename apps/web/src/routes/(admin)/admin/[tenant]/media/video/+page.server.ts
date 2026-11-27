// The file itself uploads directly. This page holds the site's metadata, settings and status.
import {
  MAX_TRANSCRIPT,
  UseCaseError,
  can,
  LICENCE_CODES,
  MAX_PAGE_SIZE,
  useCases,
} from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { langOf } from '../../../../../../i18n/index.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { failureOf, loaded, text } from '#lib/server/admin/admin-actions.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const write = can(principal, 'media:write');
  const [{ videos }, bound, media] = await Promise.all([
    loaded(rt.invoker.run(useCases.listVideos, principal, {})),
    rt.uow.run(principal, async (ctx) => !!ctx.videoProvider),
    write
      ? rt.invoker.run(useCases.listMedia, principal, { kind: 'image', limit: MAX_PAGE_SIZE })
      : null,
  ]);
  const id = url.searchParams.get('recording');
  const language = url.searchParams.get('language') ?? tenant.defaultLocale;
  const transcript =
    write && id && tenant.locales.includes(language)
      ? {
          ...(await loaded(
            rt.invoker.run(useCases.getTranscript, principal, { id, locale: language })
          )),
          id,
          language,
        }
      : null;
  locals.videoUploadPage = write && bound;
  return {
    tenant,
    locale: langOf(locals),
    videos,
    transcript,
    canPublish: can(principal, 'content:publish'),
    canUpload: write && bound,
    canWrite: write,
    licences: LICENCE_CODES.filter((code) => code !== 'other'),
    posters: (media?.items ?? [])
      .filter((image) => image.access === 'public' && image.state === 'ready')
      .map((image) => ({ value: image.id, label: image.filename })),
  };
};

const transcriptAction =
  (publish: boolean): Actions[string] =>
  async ({ locals, url, params, request }) => {
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const data = await request.formData();
    const id = text(data, 'id');
    const locale = text(data, 'language');
    const version = text(data, 'version');
    let source = text(data, 'source');
    const chapters = text(data, 'chapters');
    try {
      if (publish) {
        await runtime().invoker.run(useCases.publishTranscript, principal, { id, locale, version });
      } else {
        const file = data.get('file');
        if (file instanceof File && file.name) {
          if (file.size > MAX_TRANSCRIPT * 4)
            throw new UseCaseError('invalid_input', 'File too large');
          source = await file.text();
        }
        await runtime().invoker.run(useCases.saveTranscript, principal, {
          id,
          locale,
          version,
          source,
          chapters,
        });
      }
      return { ok: true, saved: !publish };
    } catch (e) {
      const { status, body } = failureOf(refusalOf(e), 'transcript', {
        conflict: 'admin.video.transcript.conflict',
        invalid: 'admin.video.transcript.invalid',
      });
      return fail(status, {
        ok: false,
        error: body.error,
        source,
        // A refused publish posts no chapters; the field then shows the saved ones.
        chapters: publish ? undefined : chapters,
        version,
        id,
        language: locale,
      });
    }
  };

export const actions: Actions = {
  saveTranscript: transcriptAction(false),
  publishTranscript: transcriptAction(true),
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
