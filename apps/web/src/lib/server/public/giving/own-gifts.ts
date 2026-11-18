// The donor's own page (ADR 005 rule 6, brief MY-254 PR 3), shared by `/my-giving` (a signed-in
// reader, or the form to ask for a link) and `/my-giving/<token>` (the link from a mail). Who the
// gifts belong to is the core's to decide from the token or the reader session; this module only
// puts the answer in the page's language and turns the four buttons into `donation.self.update`.
//
// Every refusal of the token is one 404, the same for a forged, expired, another site's or an
// erased giver's link. Each change posts and answers with a 303 to the same page with `?done=`,
// so a refresh repeats nothing. Headers as the reader flow: `no-store`, `noindex`, and at most the
// origin as referrer, since the token is in the path.
// Rejected: the token in a hidden field and a tokenless URL (the mail's link is the page, and a
// bookmark of it should keep working for its week), and one action with the change in a field
// (four small forms each say what their button does).

import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { useCases, type OwnGift, type Principal } from '@mycel/core';
import { fill, ui } from '../../../../i18n/index.js';
import { formatMoney } from '../../../money.js';
import { refusalOf, refuse } from '../../http/refuse.js';
import { runtime } from '../../runtime.js';
import { requireSite, sitePath, type Site } from '../../site.js';
import { answerLocale } from '../confirm.js';
import { READER_HEADERS, readerOfRequest, readerVisitor } from '../reader.js';

export const OWN_GIFTS_PATH = '/my-giving';

export type OwnGiftChange = 'amount' | 'pause' | 'resume' | 'cancel';
const CHANGES: readonly OwnGiftChange[] = ['amount', 'pause', 'resume', 'cancel'];

export interface OwnGiftView {
  id: string;
  title: string;
  facts: { term: string; value: string }[];
  /** Running or paused: the amount, pause or resume, and stop forms. */
  open: boolean;
  paused: boolean;
  /** The amount in euros as the amount field shows it (`12.50`). */
  euros: string;
}

/** The language of the page: the `lang` the mail's link carries, else the browser's. */
export function ownGiftsLocale(site: Site, event: Pick<RequestEvent, 'request' | 'url'>): string {
  return answerLocale(site, event.request, event.url.searchParams.get('lang'));
}

export function viewOf(gift: OwnGift, locale: string, timeZone: string): OwnGiftView {
  const t = ui(locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const at = (iso: string) => day.format(new Date(iso));
  const amount = formatMoney(gift.amount, gift.currency, locale);
  const facts = [
    { term: t('public.ownGifts.status'), value: t(`public.ownGifts.status.${gift.status}`) },
  ];
  if (gift.nextChargeAt)
    facts.push({ term: t('public.ownGifts.next'), value: at(gift.nextChargeAt) });
  if (gift.status === 'active' && gift.failedAttempts)
    facts.push({ term: t('public.ownGifts.failed'), value: String(gift.failedAttempts) });
  if (gift.startedAt) facts.push({ term: t('public.ownGifts.since'), value: at(gift.startedAt) });
  return {
    id: gift.id,
    title: fill(t(`public.ownGifts.title.${gift.interval}`), { amount }),
    facts,
    open: gift.status === 'active' || gift.status === 'paused',
    paused: gift.status === 'paused',
    euros: (gift.amount / 100).toFixed(gift.amount % 100 ? 2 : 0),
  };
}

/** The gifts `principal` reaches with `token`, or null when the core says nobody. */
export async function ownGifts(
  site: Site,
  principal: Principal,
  token: string | undefined,
  locale: string
): Promise<OwnGiftView[] | null> {
  const { invoker } = runtime();
  let gifts: OwnGift[];
  try {
    ({ gifts } = await invoker.run(useCases.getOwnGifts, principal, token ? { token } : {}));
  } catch (e) {
    if (refusalOf(e).code === 'not_found') return null;
    throw e;
  }
  const { timeZone } = (await invoker.run(useCases.getSiteGeneral, readerVisitor(site), {})).value;
  return gifts.map((g) => viewOf(g, locale, timeZone));
}

/** The words of the page, in its language. */
export function ownGiftsLabels(locale: string) {
  const t = ui(locale);
  return {
    title: t('public.ownGifts.heading'),
    intro: t('public.ownGifts.intro'),
    none: t('public.ownGifts.none'),
    amount: t('public.ownGifts.amount'),
    amountHint: t('public.ownGifts.amountHint'),
    amountSubmit: t('public.ownGifts.amountSubmit'),
    pause: t('public.ownGifts.pause'),
    pauseHint: t('public.ownGifts.pauseHint'),
    resume: t('public.ownGifts.resume'),
    stop: t('public.ownGifts.stop'),
    stopHint: t('public.ownGifts.stopHint'),
    stopConfirm: t('public.ownGifts.stopConfirm'),
    requestIntro: t('public.ownGifts.requestIntro'),
    email: t('reader.signin.email'),
    requestSubmit: t('public.ownGifts.requestSubmit'),
    sent: t('public.ownGifts.sent'),
    honeypot: t('form.honeypot.label'),
    suspended: t('site.suspended.body'),
  };
}

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

/** "12,50", "12.50", "€ 12" → 1250 cents, or null. */
export function centsOf(input: string): number | null {
  const cleaned = input.replace(/[€\s]/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * The four changes as SvelteKit actions. `tokenOf` gives the link's token, or undefined on the
 * reader's page, where the session says who gives.
 */
export function ownGiftActions(tokenOf: (event: RequestEvent) => string | undefined) {
  const change =
    (action: OwnGiftChange) =>
    async (event: RequestEvent): Promise<unknown> => {
      const { locals, request, cookies, setHeaders, getClientAddress, url } = event;
      const rt = runtime();
      const site = requireSite(locals);
      const locale = ownGiftsLocale(site, event);
      const t = ui(locale);
      const token = tokenOf(event);
      const principal = token
        ? readerVisitor(site, rt.signer.hashIp(getClientAddress()))
        : await readerOfRequest(cookies, site);
      if (!principal) refuse(404);
      const data = await request.formData();
      const subscriptionId = text(data, 'gift');
      let amount: number | undefined;
      if (action === 'amount') {
        const cents = centsOf(text(data, 'amount'));
        if (cents === null || cents < 100 || cents > 5_000_000)
          return fail(400, { gift: subscriptionId, message: t('public.ownGifts.amountInvalid') });
        amount = cents;
      }
      try {
        await rt.invoker.run(useCases.updateOwnGift, principal, {
          ...(token ? { token } : {}),
          subscriptionId,
          action,
          ...(amount === undefined ? {} : { amount }),
        });
      } catch (e) {
        const { code } = refusalOf(e);
        if (code === 'not_found' || code === 'invalid_input') refuse(404);
        if (code === 'conflict')
          return fail(409, { gift: subscriptionId, message: t('public.ownGifts.conflict') });
        if (code === 'suspended')
          return fail(403, { gift: subscriptionId, message: t('site.suspended.body') });
        throw e;
      }
      setHeaders(READER_HEADERS);
      const query = new URLSearchParams({ done: action });
      const lang = url.searchParams.get('lang');
      if (lang) query.set('lang', lang);
      redirect(303, `${url.pathname}?${query}`);
    };
  return Object.fromEntries(CHANGES.map((c) => [c, change(c)])) as Record<
    OwnGiftChange,
    (event: RequestEvent) => Promise<unknown>
  >;
}

/** The status line after a change, from `?done=`. */
export function doneMessage(url: URL, locale: string): string | null {
  const done = url.searchParams.get('done');
  return done && (CHANGES as readonly string[]).includes(done)
    ? ui(locale)(`public.ownGifts.done.${done as OwnGiftChange}`)
    : null;
}

export const ownGiftsPath = (site: Site, rest = ''): string =>
  sitePath(site, `${OWN_GIFTS_PATH}${rest}`);
