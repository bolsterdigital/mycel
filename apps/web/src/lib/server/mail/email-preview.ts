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
import { emailSite } from './newsletter.js';

export const EMAIL_FRAME_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src https: http: data:',
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** The path of the frame route that serves the rendered HTML; with `edition`, that one as sent. */
export const emailFramePath = (
  slug: string,
  itemId: string,
  locale: string,
  edition: string | null = null
) =>
  `/admin/${slug}/preview/email/${itemId}?${new URLSearchParams({ locale, ...(edition ? { edition } : {}) })}`;

/**
 * The latest revision as mail (`mailing.email.get`), or with `edition` a sent edition as it went
 * out (`mailing.edition.get`): the same page and frame show both.
 */
export async function renderItemEmail(
  principal: Principal,
  tenant: { slug: string; name: string; defaultLocale: string },
  itemId: string,
  locale: string,
  edition: string | null = null
): Promise<{ subject: string; html: string; text: string }> {
  const site = await emailSite(principal, tenant);
  return edition
    ? runtime().invoker.run(useCases.getEdition, principal, {
        itemId,
        locale,
        site,
        editionId: edition,
      })
    : runtime().invoker.run(useCases.getEmail, principal, { itemId, locale, site });
}

/**
 * The HTML for the frame: links open outside it, since the site refuses to be framed by the
 * admin. Only here, never in what is sent.
 */
export const framed = (html: string) => html.replace('<head>', '<head><base target="_blank">');
