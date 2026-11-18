// The consent choice page of a site (docs/reference/integrations.md § Consent): per category what
// this site loads under it, a checkbox for each, and one button that saves. The post sets the
// first-party cookie and goes back to the page it came from with a 303, so it works without
// JavaScript; the banner's two buttons post here too (`choice=all|necessary`). The page reads the
// cookie to show the current choice, so it is private and never cached; a content page never reads
// it. Withdrawing is saving with nothing ticked: the page reloads and nothing loads any more.
// Rejected: a separate "withdraw" action, which is the same choice under another name.

import { redirect } from '@sveltejs/kit';
import { CONSENT_CATEGORIES, safeReturnPath, type ConsentCategory } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { answerLocale } from '#lib/server/public/confirm.js';
import { READER_HEADERS } from '#lib/server/public/reader.js';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE,
  CONSENT_PATH,
  consentCookiePath,
  parseConsent,
  serializeConsent,
} from '#lib/server/public/scripts/consent.js';
import { loadsText, sitePlacement } from '#lib/server/public/scripts/integrations.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request, locals, cookies, setHeaders }) => {
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const locale = answerLocale(site, request, null);
  locals.lang = locale;
  const t = ui(locale);
  const granted = parseConsent(cookies.get(CONSENT_COOKIE)) ?? [];
  const { tagManager } = await sitePlacement(site);
  const back = safeReturnPath(url.searchParams.get('return')) ?? sitePath(site, '/');
  return {
    title: t('consent.page.title'),
    intro: t('consent.page.intro'),
    necessary: t('consent.page.necessary'),
    save: t('consent.page.save'),
    backLabel: t('consent.page.back'),
    action: sitePath(site, CONSENT_PATH),
    back,
    categories: CONSENT_CATEGORIES.map((category) => ({
      category,
      label: t(`consent.category.${category}`),
      hint: t(`consent.category.${category}.hint`),
      loads:
        tagManager?.category === category
          ? t('consent.category.loads').replace('{loads}', () =>
              loadsText(locale, tagManager.vendors)
            )
          : t('consent.category.nothing'),
      checked: granted.includes(category),
    })),
  };
};

export const actions: Actions = {
  default: async ({ request, url, locals, cookies, setHeaders }) => {
    const site = requireSite(locals);
    const data = await request.formData();
    const choice = data.get('choice');
    const granted: ConsentCategory[] =
      choice === 'all'
        ? [...CONSENT_CATEGORIES]
        : choice === 'necessary'
          ? []
          : CONSENT_CATEGORIES.filter((category) => data.get(category) === 'on');
    cookies.set(CONSENT_COOKIE, serializeConsent(granted), {
      path: consentCookiePath(site),
      maxAge: CONSENT_MAX_AGE,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      // The banner's script reads and writes the same cookie.
      httpOnly: false,
    });
    setHeaders(READER_HEADERS);
    const back = data.get('return');
    redirect(303, safeReturnPath(typeof back === 'string' ? back : null) ?? sitePath(site, '/'));
  },
};
