// Where the two posts of the sign-in flow land with a 303: `sent` after asking for a link (the
// same page for every address) and `invalid` for a link that signs nobody in. Reading these
// pages changes nothing, so a refresh or a shared address is harmless; any other segment is a 404.

import { ui } from '../../../../../../i18n/index.js';
import { answerLocale } from '#lib/server/public/confirm.js';
import {
  READER_HEADERS,
  READER_PATH,
  signinOutcomeCopy,
  signinOutcomeOf,
} from '#lib/server/public/reader.js';
import { refuse } from '#lib/server/http/refuse.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, locals, setHeaders }) => {
  setHeaders(READER_HEADERS);
  const site = requireSite(locals);
  const outcome = signinOutcomeOf(params.outcome);
  if (!outcome) refuse(404);
  const locale = answerLocale(site, request, null);
  locals.lang = locale;
  const t = ui(locale);
  const copy = signinOutcomeCopy(outcome);
  return {
    title: t(copy.title),
    body: t(copy.body),
    // A link that did not work leads back to the form; "sent" has nothing to do but wait.
    again:
      outcome === 'invalid'
        ? { href: sitePath(site, READER_PATH), label: t('reader.invalid.again') }
        : null,
  };
};
