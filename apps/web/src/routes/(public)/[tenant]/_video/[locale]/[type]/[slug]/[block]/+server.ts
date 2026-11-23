// A POST is the visitor's deliberate play action. The initial article carries only this
// same-site endpoint, and the player response and track both carry private no-store headers.
import {
  anonymousPrincipal,
  contentPath,
  grantVideo,
  readVideoTrack,
  VideoPlacement,
} from '@mycel/core';
import { error } from '@sveltejs/kit';
import hlsScript from 'hls.js/dist/hls.light.min.js?url';
import { escape } from '#lib/blocks/rich-text.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import { PRIVATE_NO_STORE } from '#lib/server/http/http-cache.js';
import { ui } from '../../../../../../../../i18n/index.js';
import type { RequestEvent, RequestHandler } from './$types';

function context({ locals, params }: RequestEvent) {
  const site = requireSite(locals);
  const target = VideoPlacement.safeParse({
    locale: params.locale,
    type: params.type,
    slug: params.slug,
    block: params.block,
  });
  if (!target.success || !site.tenant.locales.includes(target.data.locale)) error(404);
  const principal = anonymousPrincipal(siteTenant(site), ['content:read', 'media:read']);
  return { site, target: target.data, principal };
}

const hidden = {
  'cache-control': PRIVATE_NO_STORE,
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
};

export const GET: RequestHandler = async (event) => {
  const { target, principal } = context(event);
  const signature = event.url.searchParams.get('sig');
  if (!signature || signature.length > 1024) error(404);
  const exp = Number(event.url.searchParams.get('exp'));
  const vtt = await runtime().uow.run(principal, (ctx) =>
    readVideoTrack(ctx, target, exp, signature)
  );
  if (!vtt) error(404);
  return new Response(vtt, { headers: { ...hidden, 'content-type': 'text/vtt; charset=utf-8' } });
};

export const POST: RequestHandler = async (event) => {
  const { site, target, principal } = context(event);
  const { request } = event;
  const data = await request.formData();
  const inline = data.get('inline') === '1';
  const grant = await runtime().uow.run(principal, (ctx) => grantVideo(ctx, target));
  const t = ui(target.locale);
  const back = sitePath(site, contentPath(target, target.locale, site.tenant.defaultLocale));
  const trackSrc = new URLSearchParams({
    exp: String(grant?.track?.expires),
    sig: grant?.track?.signature ?? '',
  });
  const track = grant?.track
    ? `<track kind="captions" srclang="${escape(target.locale)}" label="${escape(t('video.captions'))}" src="?${escape(trackSrc.toString())}">`
    : '';
  const title = grant?.title ?? t('video.unavailable');
  const fallback = `<a href="${escape(back)}" ${inline ? 'target="_top"' : ''}>${escape(t('video.back'))}</a>`;
  const player = grant
    ? `<video controls playsinline preload="none" crossorigin="anonymous" aria-label="${escape(title)}"
        src="${escape(grant.mp4)}" data-hls="${escape(grant.hls)}" data-mp4="${escape(grant.mp4)}">${track}</video>
      <p id="unavailable" hidden>${escape(t('video.unavailable'))} ${fallback}</p>
      <script defer src="${escape(hlsScript)}"></script><script defer src="/_site/native-video.js"></script>`
    : `<p>${escape(title)}</p>`;
  const origin = grant ? new URL(grant.hls).origin : null;
  const sources = origin ? `media-src 'self' blob: ${origin}; connect-src 'self' ${origin};` : '';
  const html = `<!doctype html><html lang="${escape(target.locale)}"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title><link rel="stylesheet" href="/_site/native-video.css">
    <body${inline ? ' class="inline"' : ''}><main>${inline ? '' : `<h1>${escape(title)}</h1>`}
    ${player}${inline && grant ? '' : fallback}</main></body></html>`;
  return new Response(html, {
    status: grant ? 200 : 404,
    headers: {
      ...hidden,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; ${sources} frame-ancestors 'self'; object-src 'none'; base-uri 'none'`,
    },
  });
};
