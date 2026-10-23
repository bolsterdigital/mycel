// Where the confirm post lands with a 303 (TODO #22B): one of three outcomes, without the token,
// in the signup's locale (`?locale=`) or else Accept-Language. Reading this page changes nothing,
// so a refresh or a shared link is harmless; any other segment is a 404.

import { error } from '@sveltejs/kit';
import { ui } from '../../../../../i18n/index.js';
import { CONFIRM_HEADERS, OUTCOME_COPY, answerLocale, outcomeOf } from '#lib/server/confirm.js';
import { requireSite } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, request, locals, setHeaders }) => {
  setHeaders(CONFIRM_HEADERS);
  const site = requireSite(locals);
  const outcome = outcomeOf(params.outcome);
  if (!outcome) error(404, 'Not found');
  const locale = answerLocale(site, request, url.searchParams.get('locale'));
  locals.lang = locale;
  const t = ui(locale);
  const copy = OUTCOME_COPY[outcome];
  return { title: t(copy.title), body: t(copy.body) };
};
