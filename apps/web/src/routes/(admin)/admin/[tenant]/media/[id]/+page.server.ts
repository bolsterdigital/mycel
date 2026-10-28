// One asset of the media library (brief #56 § C1, on the detail pattern): a large preview with a
// full-size lightbox, its facts, the pages whose latest version uses it, the edit form and
// delete. Preview and lightbox are resized variants from the admin's own route, never the
// original, which stays a signed ten-minute download (TODO #10b). Where it is used comes from
// `content.item.find` and only for an operator who may read content; everyone else sees the
// count. Rejected: a usage list inside `media.get`, which would hand content titles to a
// `media:read`-only key.
import {
  UseCaseError,
  can,
  useCases,
  type MediaAccess,
  type MediaCredit,
  type MediaView,
} from '@mycel/core';
import { error, redirect } from '@sveltejs/kit';
import { act, text } from '#lib/server/admin-actions.js';
import { ORIGINAL_TTL_MS, signedOriginalPath } from '#lib/server/media.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How many pages the usage list names before "and n more". */
const USAGE_LINKS = 20;
/** The preview's width: sharp in the detail column, light enough for the first paint. */
const PREVIEW_WIDTH = 960;

/** The preview's and the lightbox's variant file, or null for a kind without an image. */
function previewFiles(m: Pick<MediaView, 'variants'>): { preview: string; full: string } | null {
  const gif = m.variants.find((v) => v.name === 'file' && v.format === 'gif');
  if (gif) return { preview: 'file.gif', full: 'file.gif' };
  const sized = m.variants
    .filter((v) => /^w\d+$/.test(v.name) && v.format === 'webp')
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const largest = sized.at(-1);
  if (!largest) return null;
  const preview = sized.filter((v) => (v.width ?? 0) <= PREVIEW_WIDTH).at(-1) ?? sized[0]!;
  return { preview: `${preview.name}.webp`, full: `${largest.name}.webp` };
}

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { tenant } = await parent();
  if (!UUID.test(params.id)) error(404, 'Not found');
  const principal = locals.principal!;
  const rt = runtime();
  let m: MediaView;
  try {
    m = await rt.invoker.run(useCases.getMedia, principal, { id: params.id });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
  const [usedIn, info] = await Promise.all([
    can(principal, 'content:read')
      ? rt.invoker.run(useCases.findItems, principal, {
          ref: { type: 'media', id: m.id },
          limit: USAGE_LINKS,
        })
      : null,
    rt.tenants.findBySlug(params.tenant),
  ]);
  const expiresAt = new Date(rt.clock.now().getTime() + ORIGINAL_TTL_MS);
  const files = previewFiles(m);
  const variant = (file: string) => `/admin/${tenant.slug}/media/${m.id}/variant/${file}`;
  return {
    media: m,
    preview: files && {
      src: variant(files.preview),
      full: variant(files.full),
      width: m.width,
      height: m.height,
    },
    original: await signedOriginalPath(rt.signer, tenant.slug, m, expiresAt),
    usedIn: usedIn && {
      items: usedIn.items.map((item) => ({
        id: item.id,
        title: item.title,
        def: item.defaultLocale,
      })),
      more: usedIn.next !== null,
    },
    locales: info?.locales ?? [],
  };
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
  update: (event) =>
    act(
      event,
      'update',
      { conflict: 'admin.error.invalid', invalid: 'admin.media.error.fields' },
      async (principal, data) => {
        const rt = runtime();
        const info = await rt.tenants.findBySlug(event.params.tenant);
        const m = await rt.invoker.run(useCases.updateMedia, principal, {
          id: event.params.id,
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
      async (principal) => {
        await runtime().invoker.run(useCases.deleteMedia, principal, { id: event.params.id });
        redirect(303, `/admin/${event.params.tenant}/media?done=deleted`);
      },
      // "In use in n places": the count from the register; the page lists where, for a reader.
      async (e: UseCaseError, principal): Promise<Record<string, string | number>> => {
        if (e.code !== 'conflict') return {};
        const m = await runtime().invoker.run(useCases.getMedia, principal, {
          id: event.params.id,
        });
        return { n: m.usageCount, filename: m.filename };
      }
    ),
};
