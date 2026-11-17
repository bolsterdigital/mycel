// Where the link in the sign-in mail lands (ADR 016 rule 1). Opening it only shows a page with
// one native form and one button; nothing is read or written for the token. Only that form's
// POST runs `reader.signin.complete`, sets the reader cookie and answers with a 303 to a
// tokenless page, so a mail scanner or a preview fetch signs nobody in and burns no link, a
// refresh repeats nothing and the address bar no longer holds the token.
//
// Every failure is one page: forged, expired, used, of another site, of an erased address or a
// site at its supporter limit all go to `/reader/signin/invalid`. The return path was stored
// with the link and checked then; it is a path on this site or nothing.
// Rejected: signing in on the GET (the double opt-in's lesson, mailing/service.ts) and validating
// the token on the GET to show "expired" early (a second place that decides, for a page whose
// button gives the same answer).

import { fail, redirect } from '@sveltejs/kit';
import { safeReturnPath, useCases } from '@mycel/core';
import { ui } from '../../../../../i18n/index.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { answerLocale } from '#lib/server/public/confirm.js';
import {
  READER_HEADERS,
  READER_PATH,
  readerVisitor,
  setReaderCookie,
  signinOutcomePath,
} from '#lib/server/public/reader.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request, locals, setHeaders }) => {
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const token = url.searchParams.get('token') ?? '';
  if (!token) redirect(303, sitePath(site, READER_PATH));
  const locale = answerLocale(site, request, null);
  locals.lang = locale;
  const t = ui(locale);
  const suspended = site.access.status === 'suspended';
  return {
    title: t(suspended ? 'site.suspended.title' : 'reader.complete.title'),
    body: t(suspended ? 'site.suspended.body' : 'reader.complete.body'),
    complete: suspended
      ? null
      : {
          action: sitePath(site, `${READER_PATH}/signin`),
          token,
          label: t('reader.complete.button'),
        },
  };
};

export const actions: Actions = {
  default: async ({ request, url, locals, cookies, setHeaders }) => {
    const rt = runtime();
    const site = requireSite(locals);
    // The headers go on a redirect only: after a `fail` the page loads again and sets them.
    const leave = (to: string): never => {
      setHeaders(READER_HEADERS);
      redirect(303, to);
    };
    const token = (await request.formData()).get('token');
    if (typeof token !== 'string' || !token) return leave(signinOutcomePath(site, 'invalid'));
    let result;
    try {
      result = await rt.invoker.run(useCases.completeSignin, readerVisitor(site), { token });
    } catch (e) {
      const { code } = refusalOf(e);
      if (code === 'suspended') {
        const t = ui(answerLocale(site, request, null));
        return fail(403, { title: t('site.suspended.title'), body: t('site.suspended.body') });
      }
      // The site is at its supporter limit, or the token is no string a link could be: the
      // visitor gets the one failure page, we get a line (no token, no address).
      rt.log.warn('reader.signin.complete refused', { code });
      return leave(signinOutcomePath(site, 'invalid'));
    }
    if (result.status !== 'signed_in') return leave(signinOutcomePath(site, 'invalid'));
    setReaderCookie(cookies, site, url, result.sessionToken, new Date(result.expiresAt));
    return leave(sitePath(site, safeReturnPath(result.returnPath) ?? READER_PATH));
  },
};
