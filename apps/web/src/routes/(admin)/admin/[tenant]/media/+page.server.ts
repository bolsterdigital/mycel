// The media library of a site in the admin (TODO #10b, brief #10 decision 10): upload, list,
// edit and delete through the same use cases HTTP and MCP expose, with native form posts and no
// JavaScript. The upload is a multipart form; the action reads the file and hands it to
// `media.upload` as base64, the one contract of that use case (brief decision 6). Rejected: a
// multipart variant of the use case for the admin only, a second contract for one operation.
//
// The list shows each asset's thumbnail and its "download original" link from the admin's own
// routes (`media/[id]/thumb`, `media/[id]/original`): the admin is on the platform origin, the
// site's `/media/...` route on the tenant's hostnames. The original's link is signed for ten
// minutes here, at render time.
import {
  MAX_UPLOAD_BYTES,
  UseCaseError,
  can,
  useCases,
  type MediaAccess,
  type MediaCredit,
} from '@mycel/core';
import { fail } from '@sveltejs/kit';
import { act, text } from '#lib/server/admin-actions.js';
import { ORIGINAL_TTL_MS, signedOriginalPath } from '#lib/server/media.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, url, params }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const rt = runtime();
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const [list, usage, info] = await Promise.all([
    rt.invoker.run(useCases.listMedia, principal, { cursor, limit: 50 }),
    can(principal, 'tenant:admin') ? rt.invoker.run(useCases.getUsage, principal, {}) : null,
    rt.tenants.findBySlug(params.tenant),
  ]);
  const expiresAt = new Date(rt.clock.now().getTime() + ORIGINAL_TTL_MS);
  const items = await Promise.all(
    list.items.map(async (m) => ({
      ...m,
      thumb: m.variants.some((v) => v.name === 'thumb')
        ? `/admin/${tenant.slug}/media/${m.id}/thumb`
        : null,
      original: await signedOriginalPath(rt.signer, tenant.slug, m, expiresAt),
    }))
  );
  return {
    items,
    nextCursor: list.nextCursor,
    storage: usage?.storage ?? null,
    locales: info?.locales ?? [],
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
};

/** Core's i18n key of a refused upload, mapped to the admin's copy. */
const UPLOAD_ISSUES: Record<string, UiKey> = {
  'media.type.svg': 'admin.media.error.svg',
  'media.type.unsupported': 'admin.media.error.type',
  'media.type.mismatch': 'admin.media.error.mismatch',
  'media.type.unreadable': 'admin.media.error.unreadable',
  'media.pixels.too_many': 'admin.media.error.pixels',
  'media.size.too_large': 'admin.media.error.tooLarge',
  'media.bytes.empty': 'admin.media.error.noFile',
  'media.filename.empty': 'admin.media.error.noFile',
  'media.filename.too_long': 'admin.media.error.filename',
  'media.filename.invalid': 'admin.media.error.filename',
};

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** The editorial fields of the edit form, as `media.update` takes them. */
function editorial(data: FormData, locales: readonly string[]) {
  const caption: Record<string, string> = {};
  for (const locale of locales) {
    const value = text(data, `caption.${locale}`).trim();
    if (value) caption[locale] = value;
  }
  const title = text(data, 'work.title').trim();
  const maker = text(data, 'work.maker').trim();
  const credit: MediaCredit = {
    work: title || maker ? { title, maker } : null,
    photographer: orNull(text(data, 'photographer')),
  };
  const focal = { x: Number(text(data, 'focal.x')), y: Number(text(data, 'focal.y')) };
  return {
    caption,
    credit,
    source: orNull(text(data, 'source')),
    licence: orNull(text(data, 'licence')),
    focal,
    access: (text(data, 'access') === 'restricted' ? 'restricted' : 'public') as MediaAccess,
  };
}

export const actions: Actions = {
  upload: (event) =>
    act(
      event,
      'upload',
      {
        conflict: 'admin.error.invalid',
        invalid: 'admin.media.error.invalid',
        issues: UPLOAD_ISSUES,
      },
      async (principal, data) => {
        const file = data.get('file');
        if (!(file instanceof File) || file.size === 0)
          return fail(400, { action: 'upload', error: 'admin.media.error.noFile' as UiKey });
        if (file.size > MAX_UPLOAD_BYTES)
          return fail(400, { action: 'upload', error: 'admin.media.error.tooLarge' as UiKey });
        const m = await runtime().invoker.run(useCases.uploadMedia, principal, {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
          access: text(data, 'access') === 'restricted' ? 'restricted' : 'public',
        });
        return {
          action: 'upload',
          done: 'admin.media.done.uploaded' as UiKey,
          filename: m.filename,
        };
      }
    ),
  update: (event) =>
    act(
      event,
      'update',
      { conflict: 'admin.error.invalid', invalid: 'admin.media.error.fields' },
      async (principal, data) => {
        const rt = runtime();
        const info = await rt.tenants.findBySlug(event.params.tenant);
        const m = await rt.invoker.run(useCases.updateMedia, principal, {
          id: text(data, 'id'),
          ...editorial(data, info?.locales ?? []),
        });
        return {
          action: 'update',
          done: 'admin.media.done.updated' as UiKey,
          filename: m.filename,
        };
      }
    ),
  delete: (event) =>
    act(
      event,
      'delete',
      { conflict: 'admin.media.error.inUse.other', notFound: 'admin.media.error.notFound' },
      async (principal, data) => {
        await runtime().invoker.run(useCases.deleteMedia, principal, { id: text(data, 'id') });
        return {
          action: 'delete',
          done: 'admin.media.done.deleted' as UiKey,
          filename: text(data, 'filename'),
        };
      },
      // "In use in n places": the count from the register, never where (the refs may be drafts).
      async (e: UseCaseError, principal, data): Promise<Record<string, string | number>> => {
        if (e.code !== 'conflict') return {};
        const m = await runtime().invoker.run(useCases.getMedia, principal, {
          id: text(data, 'id'),
        });
        return { n: m.usageCount, filename: m.filename };
      }
    ),
};
