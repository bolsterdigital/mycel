// The thank-you state of a campaign (ADR 038 rule 8, ADR 033 rule 2): a campaign form accepted on
// its landing page or in a `full` card goes to the thank-you view of the landing page, with the
// page it came from as `back`; that view stands in the campaign layout with the count, plain share
// links and a link back. Ordinary forms keep the thank-you view of the page they are on.
//
// Which campaign a post belongs to is read from the page the visitor posted from, as the public
// reader sees it: the landing page's own form, or the form of a card on it. So the target is
// always a published, public landing page in this locale (the card projection checked that), and
// nothing in the post chooses it. Rejected: a `campaign` field in the form result (core would hand
// a web path to every front) and a landing path in the post (a visitor could type any path).

import type { RenderBlock, RenderModel } from '#lib/blocks/model.js';
import type { Ui } from '../../../i18n/index.js';

/** A site-root path plus `/thanks`; the homepage's is `/thanks`. */
const thanksOf = (path: string) => `${path === '/' ? '' : path}/thanks`;

/**
 * Where a post of `formId` from the page at `here` (site-root path) goes once accepted: the
 * landing page's thank-you view when the form is a campaign's on this page, else null (the page's
 * own thank-you view).
 */
export function campaignThanksPath(
  model: Pick<RenderModel, 'campaign' | 'blocks'>,
  extra: readonly RenderBlock[],
  formId: string,
  here: string
): string | null {
  if (model.campaign?.form?.formId === formId) return thanksOf(here);
  for (const block of [...model.blocks, ...extra])
    if (block.type === 'campaign-card' && block.campaign && block.form?.formId === formId)
      return `${thanksOf(block.campaign.href)}?${new URLSearchParams({ back: here })}`;
  return null;
}

export interface ShareLink {
  label: string;
  href: string;
}

/**
 * Share links without third-party scripts (ADR 038 rule 8): a mail, WhatsApp and Bluesky, each an
 * ordinary link that opens the service with the title and address filled in. The address itself
 * is shown beside them, so it can be copied anywhere else.
 */
export function shareLinks(title: string, url: string, t: Ui): ShareLink[] {
  const text = `${title} ${url}`;
  return [
    {
      label: t('thanks.share.email'),
      href: `mailto:?${new URLSearchParams({ subject: title, body: url }).toString().replaceAll('+', '%20')}`,
    },
    { label: t('thanks.share.whatsapp'), href: `https://wa.me/?text=${encodeURIComponent(text)}` },
    {
      label: t('thanks.share.bluesky'),
      href: `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`,
    },
  ];
}
