// The reader page of a site (ADR 016 rule 1): a visitor asks for a sign-in link here; a signed-in
// reader sees their own account (address, access per tier, newsletters, last sign-in, what the
// site keeps), leaves a newsletter and signs out (reader-account.ts). Native forms, no JavaScript
// needed (ADR 009); the proof-of-work script only adds a solution when it runs.
//
// The request form is a public form that causes mail, so it carries the house defence
// (`formulieren-en-mail`): a honeypot, a signed minimum fill time, ALTCHA, limits per client and
// one mail per address per day in the core. Its answer is one page for everyone: the post
// redirects to "check your mail" whether the address is known, limited, refused or a bot's, so
// the route tells nobody who reads this site. Only a value that is no e-mail address at all gets
// the form back, which says nothing about anyone.
//
// The tenant is the site of the request (the hostname), the client hash comes from the
// connection; nothing in the posted body can choose either (ADR 002 rule 3).
// Rejected: an inline message on the same page for "sent" or "withdrawn" (a refresh would post
// again; both redirect).

import { fail, redirect } from '@sveltejs/kit';
import {
  SIGNIN_FORM_SCOPE,
  issueProofChallenge,
  issueStartedToken,
  safeReturnPath,
  useCases,
  type Principal,
} from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import { answerLocale } from '#lib/server/public/confirm.js';
import {
  READER_HEADERS,
  READER_PATH,
  clearReaderCookie,
  readerOfRequest,
  readerVisitor,
  signinOutcomePath,
} from '#lib/server/public/reader.js';
import { runtime } from '#lib/server/runtime.js';
import { readerAccountView } from '#lib/server/public/reader-account.js';
import { requireSite, sitePath, type Site } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

/** The sign-in form's hidden fields: a fresh timing token and challenge with every render. */
async function formModel(site: Site, returnPath: string | null) {
  const rt = runtime();
  const now = rt.clock.now();
  return {
    action: `${sitePath(site, READER_PATH)}?/request`,
    startedToken: await issueStartedToken(rt.signer, SIGNIN_FORM_SCOPE, now),
    proof: await issueProofChallenge(rt.signer, SIGNIN_FORM_SCOPE, now),
    returnPath,
  };
}

function copy(site: Site, request: Request, locals: App.Locals) {
  const locale = answerLocale(site, request, null);
  locals.lang = locale;
  const t = ui(locale);
  return {
    locale,
    t,
    labels: {
      title: t('reader.title'),
      accountTitle: t('reader.account.title'),
      lastSeen: t('reader.account.lastSeen'),
      access: t('reader.account.access'),
      accessNone: t('reader.account.access.none'),
      accessChange: t('reader.account.access.change'),
      newsletters: t('reader.account.newsletters'),
      newslettersNone: t('reader.account.newsletters.none'),
      withdrawn: t('reader.account.newsletters.withdrawn'),
      privacy: t('reader.account.privacy'),
      intro: t('reader.signin.intro'),
      email: t('reader.signin.email'),
      submit: t('reader.signin.submit'),
      honeypot: t('form.honeypot.label'),
      signout: t('reader.signout.submit'),
      giving: t('reader.account.giving'),
      suspended: t('site.suspended.body'),
    },
  };
}

/** The account of the reader, or null when their session ended between the check and the read. */
async function accountOf(site: Site, reader: Principal, locale: string, url: URL) {
  try {
    return await readerAccountView(site, reader, locale, url.searchParams.get('withdrawn'));
  } catch (e) {
    if (refusalOf(e).code === 'not_found') return null;
    throw e;
  }
}

export const load: PageServerLoad = async ({ url, request, locals, cookies, setHeaders }) => {
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const { labels, locale } = copy(site, request, locals);
  let reader = await readerOfRequest(cookies, site);
  const account = reader ? await accountOf(site, reader, locale, url) : null;
  if (reader && !account) {
    clearReaderCookie(cookies, site);
    reader = null;
  }
  const suspended = site.access.status === 'suspended';
  return {
    labels,
    account,
    signoutAction: `${sitePath(site, READER_PATH)}?/signout`,
    givingHref: sitePath(site, '/my-giving'),
    // A suspended site stays readable but changes nothing (ADR 015 rule 7): no form to post.
    form:
      reader || suspended
        ? null
        : await formModel(site, safeReturnPath(url.searchParams.get('return'))),
    suspended: suspended && !reader,
  };
};

export const actions: Actions = {
  request: async ({ request, locals, setHeaders, getClientAddress }) => {
    // The headers go on the redirect only: after a `fail` the page loads again and sets them
    // itself, and a header set twice in one request is an error.
    const rt = runtime();
    const site = requireSite(locals);
    const { locale, t } = copy(site, request, locals);
    const data = await request.formData();
    const email = text(data, 'email');
    try {
      await rt.invoker.run(
        useCases.requestSignin,
        readerVisitor(site, rt.signer.hashIp(getClientAddress())),
        {
          email,
          locale,
          returnPath: text(data, 'return') || undefined,
          // An absent honeypot field is not an empty one: the core treats a post without it as a bot.
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
      // Not an address at all (or a field too long): the one refusal that says nothing of anyone.
      if (code === 'invalid_input')
        return fail(400, { email: email.slice(0, 320), message: t('reader.signin.invalidEmail') });
      throw e;
    }
    setHeaders(READER_HEADERS);
    redirect(303, signinOutcomePath(site, 'sent'));
  },

  withdraw: async ({ request, locals, cookies, setHeaders }) => {
    const site = requireSite(locals);
    const reader = await readerOfRequest(cookies, site);
    const list = text(await request.formData(), 'list');
    // A post without a standing session, or for a list too long to be one, changes nothing.
    if (reader && list && list.length <= 200)
      try {
        await runtime().invoker.run(useCases.withdrawReaderSubscription, reader, { list });
      } catch (e) {
        const { code } = refusalOf(e);
        if (code !== 'not_found' && code !== 'suspended') throw e;
      }
    setHeaders(READER_HEADERS);
    const query = reader && list ? `?${new URLSearchParams({ withdrawn: list })}` : '';
    redirect(303, `${sitePath(site, READER_PATH)}${query}`);
  },

  signout: async ({ locals, cookies, setHeaders }) => {
    setHeaders(READER_HEADERS);
    const site = requireSite(locals);
    const reader = await readerOfRequest(cookies, site);
    // Works while the site is suspended too: ending a session grows nothing. A suspended site
    // refuses the command, and the cookie goes regardless, so the browser is signed out.
    if (reader)
      try {
        await runtime().invoker.run(useCases.signoutReader, reader, {});
      } catch (e) {
        if (refusalOf(e).code !== 'suspended') throw e;
      }
    clearReaderCookie(cookies, site);
    redirect(303, sitePath(site, READER_PATH));
  },
};
