// The reader page of a site (ADR 016 rule 1): a visitor asks for a sign-in link here, a signed-in
// reader sees that they are and can sign out. Native forms, no JavaScript needed (ADR 009); the
// proof-of-work script only adds a solution when it runs.
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
// Rejected: an inline message on the same page for "sent" (a refresh would post again), and
// showing the reader's address here (the session names no address; self-service is a later page).

import { fail, redirect } from '@sveltejs/kit';
import {
  SIGNIN_FORM_SCOPE,
  issueProofChallenge,
  issueStartedToken,
  safeReturnPath,
  useCases,
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
      intro: t('reader.signin.intro'),
      email: t('reader.signin.email'),
      submit: t('reader.signin.submit'),
      honeypot: t('form.honeypot.label'),
      signedIn: t('reader.signedIn.body'),
      signout: t('reader.signout.submit'),
      suspended: t('site.suspended.body'),
    },
  };
}

export const load: PageServerLoad = async ({ url, request, locals, cookies, setHeaders }) => {
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const { labels } = copy(site, request, locals);
  const reader = await readerOfRequest(cookies, site);
  const suspended = site.access.status === 'suspended';
  return {
    labels,
    signedIn: !!reader,
    signoutAction: `${sitePath(site, READER_PATH)}?/signout`,
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
