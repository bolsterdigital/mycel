// Where the confirm post lands with a 303 (TODO #22B): one of three outcomes, without the token,
// in the signup's locale (`?locale=`) or else Accept-Language. Reading this page changes nothing,
// so a refresh or a shared link is harmless; any other segment is a 404.

import { ui } from '../../../../../i18n/index.js';
import {
  CONFIRM_HEADERS,
  answerLocale,
  confirmCopy,
  outcomeOf,
  purposeOf,
} from '#lib/server/public/confirm.js';
import { requireSite } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';
import { refuse } from '#lib/server/http/refuse.js';

export const load: PageServerLoad = async ({ params, url, request, locals, setHeaders }) => {
  setHeaders(CONFIRM_HEADERS);
  const site = requireSite(locals);
  const outcome = outcomeOf(params.outcome);
  if (!outcome) refuse(404);
  const locale = answerLocale(site, request, url.searchParams.get('locale'));
  locals.lang = locale;
  const t = ui(locale);
  const copy = confirmCopy(outcome, purposeOf(url.searchParams.get('purpose')));
  return { title: t(copy.title), body: t(copy.body) };
};
