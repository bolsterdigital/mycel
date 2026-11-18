// The link from a giver's mail (ADR 005 rule 6, brief MY-254 PR 3): `/my-giving/<token>` shows the
// gifts the token's supporter has on this site and offers the four changes; how and why:
// lib/server/public/giving/own-gifts.ts. Opening the page only reads, so a mail scanner that fetches it
// changes nothing; every change is a POST of a native form. Any token the core does not accept
// is the same 404.

import {
  ownGiftActions,
  ownGifts,
  ownGiftsLabels,
  ownGiftsLocale,
  doneMessage,
} from '#lib/server/public/giving/own-gifts.js';
import { READER_HEADERS, readerVisitor } from '#lib/server/public/reader.js';
import { refuse } from '#lib/server/http/refuse.js';
import { requireSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { locals, params, url, setHeaders } = event;
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const locale = ownGiftsLocale(site, event);
  locals.lang = locale;
  const gifts = await ownGifts(site, readerVisitor(site), params.token, locale);
  if (!gifts) refuse(404);
  const lang = url.searchParams.get('lang');
  return {
    labels: ownGiftsLabels(locale),
    gifts,
    base: `${url.pathname}${lang ? `?lang=${encodeURIComponent(lang)}&` : '?'}`,
    done: doneMessage(url, locale),
    suspended: site.access.status === 'suspended',
  };
};

export const actions: Actions = ownGiftActions((event) => event.params['token'] || undefined);
