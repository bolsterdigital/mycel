// The donor's page without a link (ADR 005 rule 6, ADR 016 rule 6, brief MY-254 PR 3): a reader
// signed in on this site sees their gifts here and changes them like the link's page does; anyone
// else gets the form that mails a link. The form is a public form that causes mail, with the house
// defence (`formulieren-en-mail`): honeypot, signed minimum fill time, ALTCHA, limits per client
// and one mail per address per day in the core. Its answer is one page for every address, so it
// tells nobody who gives; only a value that is no address at all gets the form back.
// Rejected: showing "no gifts for this address" (it would name who gives).

import { fail, redirect } from '@sveltejs/kit';
import { SELF_FORM_SCOPE, issueProofChallenge, issueStartedToken, useCases } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import {
  doneMessage,
  ownGiftActions,
  ownGifts,
  ownGiftsLabels,
  ownGiftsLocale,
  ownGiftsPath,
} from '#lib/server/public/giving/own-gifts.js';
import { READER_HEADERS, readerOfRequest, readerVisitor } from '#lib/server/public/reader.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { locals, url, cookies, setHeaders } = event;
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const locale = ownGiftsLocale(site, event);
  locals.lang = locale;
  const reader = await readerOfRequest(cookies, site);
  const gifts = reader ? await ownGifts(site, reader, undefined, locale) : null;
  const suspended = site.access.status === 'suspended';
  const rt = runtime();
  const now = rt.clock.now();
  return {
    labels: ownGiftsLabels(locale),
    gifts,
    done: doneMessage(url, locale),
    sent: url.searchParams.has('sent'),
    form:
      gifts || suspended
        ? null
        : {
            action: `${ownGiftsPath(site)}?/request`,
            startedToken: await issueStartedToken(rt.signer, SELF_FORM_SCOPE, now),
            proof: await issueProofChallenge(rt.signer, SELF_FORM_SCOPE, now),
          },
    base: `${ownGiftsPath(site)}?`,
    suspended,
  };
};

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

export const actions: Actions = {
  ...ownGiftActions(() => undefined),
  request: async (event) => {
    const { request, locals, setHeaders, getClientAddress } = event;
    const rt = runtime();
    const site = requireSite(locals);
    const locale = ownGiftsLocale(site, event);
    const t = ui(locale);
    const data = await request.formData();
    const email = text(data, 'email');
    try {
      await rt.invoker.run(
        useCases.requestOwnGiftsLink,
        readerVisitor(site, rt.signer.hashIp(getClientAddress())),
        {
          email,
          locale,
          // An absent honeypot field is not an empty one: the core treats it as a bot.
          spam: {
            honeypot: data.has('website') ? text(data, 'website') : undefined,
            startedToken: text(data, '_started'),
            proof: text(data, '_proof') || undefined,
          },
        }
      );
    } catch (e) {
      const { code } = refusalOf(e);
      if (code === 'suspended') return fail(403, { email, message: t('site.suspended.body') });
      if (code === 'invalid_input')
        return fail(400, { email: email.slice(0, 320), message: t('reader.signin.invalidEmail') });
      throw e;
    }
    setHeaders(READER_HEADERS);
    redirect(303, `${ownGiftsPath(site)}?sent`);
  },
};
