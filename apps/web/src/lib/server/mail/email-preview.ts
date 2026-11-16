// An item as the newsletter it would become, for the admin's e-mail preview: the
// core renders through `mailing.email.get`; this file only supplies the site the mail links to
// (name, absolute root on the primary hostname, default locale) and the frame's own policy.
//
// The mail is shown in a frame from its own route, because mail HTML is all inline styles and
// the admin's CSP refuses those. The frame's policy allows exactly that and images from anywhere
// (they are the site's public variants), no script, no form, and framing by the admin only.
// Rejected: `srcdoc` (it inherits the admin's CSP, so every style would be dropped) and loosening
// the admin's own policy for one page.

import { useCases, type Principal } from '@mycel/core';
import { runtime } from '../runtime.js';
import { adminSiteUrls } from '../site.js';

export const EMAIL_FRAME_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src https: http: data:',
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** The path of the frame route that serves the rendered HTML. */
export const emailFramePath = (slug: string, itemId: string, locale: string) =>
  `/admin/${slug}/preview/email/${itemId}?locale=${encodeURIComponent(locale)}`;

export async function renderItemEmail(
  principal: Principal,
  tenant: { slug: string; name: string; defaultLocale: string },
  itemId: string,
  locale: string
) {
  const root = (await adminSiteUrls(principal, tenant.slug))('/').replace(/\/$/, '');
  return runtime().invoker.run(useCases.getEmail, principal, {
    itemId,
    locale,
    site: { name: tenant.name, url: root, defaultLocale: tenant.defaultLocale },
  });
}

/**
 * The HTML for the frame: links open outside it, since the site refuses to be framed by the
 * admin. Only here, never in what is sent.
 */
export const framed = (html: string) => html.replace('<head>', '<head><base target="_blank">');
