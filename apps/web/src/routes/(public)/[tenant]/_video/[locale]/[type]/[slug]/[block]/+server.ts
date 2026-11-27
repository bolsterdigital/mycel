// A POST is the visitor's deliberate play action. The initial article carries only this
// same-site endpoint, and the player response and tracks all carry private no-store headers.
// With JavaScript the page posts `renew=1` and plays the JSON grant in its own `<video>`, so the
// press on play is the activation that starts it (managed-video.js); without, the form opens the
// player page below. A `t` field is the page's `?t=` moment: the MP4's `#t=` fragment starts it
// there without script. Tracks are signed per kind (captions, chapters) and fetched by GET.
import {
  anonymousPrincipal,
  contentPath,
  grantVideo,
  readVideoTrack,
  TrackKind,
  VideoPlacement,
} from '@mycel/core';
import { error } from '@sveltejs/kit';
import hlsScript from 'hls.js/dist/hls.light.min.js?url';
import hlsModule from 'hls.js/dist/hls.light.min.mjs?url';
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

/** The moment a `t` field names, whole seconds within a day; 0 for none or anything else. */
function startOf(value: FormDataEntryValue | null): number {
  const seconds = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : 0;
  return seconds <= 86_400 ? seconds : 0;
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
  const kind = TrackKind.safeParse(event.url.searchParams.get('kind') ?? 'captions');
  if (!kind.success) error(404);
  const vtt = await runtime().uow.run(principal, (ctx) =>
    readVideoTrack(ctx, target, exp, signature, kind.data)
  );
  if (!vtt) error(404);
  return new Response(vtt, { headers: { ...hidden, 'content-type': 'text/vtt; charset=utf-8' } });
};

export const POST: RequestHandler = async (event) => {
  const { site, target, principal } = context(event);
  const { request } = event;
  const data = await request.formData();
  const grant = await runtime().uow.run(principal, (ctx) => grantVideo(ctx, target));
  const t = ui(target.locale);
  const back = sitePath(site, contentPath(target, target.locale, site.tenant.defaultLocale));
  const signed = (kind: TrackKind, sig: { expires: number; signature: string } | null) =>
    sig &&
    '?' +
      new URLSearchParams({
        ...(kind === 'chapters' ? { kind } : {}),
        exp: String(sig.expires),
        sig: sig.signature,
      });
  const trackSrc = signed('captions', grant?.track ?? null);
  const chaptersSrc = signed('chapters', grant?.chapters ?? null);
  if (data.get('renew') === '1')
    return Response.json(
      grant && {
        hls: grant.hls,
        mp4: grant.mp4,
        track: trackSrc,
        chapters: chaptersSrc,
        lifetime: grant.expires - grant.issued,
        // The HLS client the page imports where the browser has no native HLS.
        client: hlsModule,
      },
      {
        status: grant ? 200 : 404,
        headers: hidden,
      }
    );
  const start = startOf(data.get('t'));
  const track =
    (trackSrc
      ? `<track kind="captions" srclang="${escape(target.locale)}" label="${escape(t('video.captions'))}" src="${escape(trackSrc)}">`
      : '') +
    (chaptersSrc
      ? `<track kind="chapters" srclang="${escape(target.locale)}" src="${escape(chaptersSrc)}">`
      : '');
  const title = grant?.title ?? t('video.unavailable');
  const fallback = `<a href="${escape(back)}">${escape(t('video.back'))}</a>`;
  const player = grant
    ? `<video controls playsinline preload="none" crossorigin="anonymous" aria-label="${escape(title)}"
        src="${escape(grant.mp4 + (start ? `#t=${start}` : ''))}" data-start="${start}" data-lifetime="${grant.expires - grant.issued}" data-hls="${escape(grant.hls)}" data-mp4="${escape(grant.mp4)}">${track}</video>
      <p id="unavailable" hidden>${escape(t('video.unavailable'))} ${fallback}</p>
      <form method="post" id="restart"><button>${escape(t('video.restart'))}</button></form>
      <script defer src="${escape(hlsScript)}"></script><script type="module" src="/_site/native-video.js"></script>`
    : '';
  const origin = grant ? new URL(grant.hls).origin : null;
  const sources = origin ? `media-src 'self' blob: ${origin}; connect-src 'self' ${origin};` : '';
  const html = `<!doctype html><html lang="${escape(target.locale)}"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title><link rel="stylesheet" href="/_site/native-video.css">
    <body><main><h1>${escape(title)}</h1>
    ${player}${fallback}</main></body></html>`;
  return new Response(html, {
    status: grant ? 200 : 404,
    headers: {
      ...hidden,
      // Native form POSTs need their same-site Origin for the framework's CSRF check.
      'referrer-policy': 'same-origin',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; ${sources} frame-ancestors 'none'; object-src 'none'; base-uri 'none'`,
    },
  });
};
