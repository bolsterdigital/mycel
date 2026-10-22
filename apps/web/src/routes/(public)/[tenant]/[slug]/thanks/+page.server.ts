// Thank-you page after a successful post (POST/redirect/GET, so a reload never resubmits).
import { pick } from '@mycel/core';
import { ui } from '../../../../../i18n/index.js';
import { loadPublicPage } from '#lib/server/public-page.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, locals }) => {
  const site = requireSite(locals);
  const view = await loadPublicPage(site, params.slug, request.headers.get('accept-language'));
  locals.lang = view.locale;
  const form = [...view.forms.values()][0];
  return {
    title: view.title,
    message: form ? (pick(form.thankYou, view.locale, view.page.defaultLocale) ?? '') : '',
    back: { href: sitePath(site, `/${params.slug}`), label: ui(view.locale)('thanks.back') },
  };
};
