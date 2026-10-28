// Double opt-in, step two (ADR 010 rule 5, TODO #22B). Opening the link from the confirmation
// mail only reads: `mailing.opt_in.get` says whether the token is pending, and a pending one
// gets a page with one native form and one button. Only that form's POST runs `mailing.opt_in.confirm`,
// then answers with a 303 to a tokenless outcome page (`confirm/[outcome]`), so a refresh repeats
// nothing and the address bar no longer holds the token. A link scanner or a preview fetch thus
// confirms nothing. Rejected: confirming in `load` on the GET (the probe did, and a scanner then
// consents for the person), and a page that confirms with JavaScript (ADR 009).
//
// A foreign-origin POST never gets here: SvelteKit refuses a form post whose Origin is not the
// site's own with 403 (`kit.csrf`, untouched); the e2e suite proves it.

import { fail, redirect } from '@sveltejs/kit';
import { UseCaseError, anonymousPrincipal, useCases, type ConfirmPreview } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { CONFIRM_HEADERS, OUTCOME_COPY, answerLocale, outcomePath } from '#lib/server/confirm.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request, locals, setHeaders }) => {
  setHeaders(CONFIRM_HEADERS);
  const site = requireSite(locals);
  const token = url.searchParams.get('token') ?? '';
  let preview: ConfirmPreview = { status: 'invalid' };
  // The post re-renders this page without a token only when it was refused: nothing to read.
  if (token)
    preview = await runtime().invoker.run(
      useCases.previewConfirmation,
      anonymousPrincipal(siteTenant(site), ['forms:write']),
      { token }
    );
  const locale = answerLocale(site, request, preview.locale);
  locals.lang = locale;
  const t = ui(locale);
  // A suspended site stays readable but changes nothing (ADR 015 rule 7): no button to press.
  const copy =
    preview.status === 'pending' && site.access.status === 'suspended'
      ? ({ title: 'site.suspended.title', body: 'site.suspended.body' } as const)
      : preview.status === 'pending'
        ? ({ title: 'confirm.pending.title', body: 'confirm.pending.body' } as const)
        : OUTCOME_COPY[preview.status];
  const confirm =
    copy.title === 'confirm.pending.title'
      ? { action: sitePath(site, '/confirm'), token, label: t('confirm.pending.button') }
      : null;
  return { title: t(copy.title), body: t(copy.body), confirm };
};

export const actions: Actions = {
  default: async ({ request, locals, setHeaders }) => {
    setHeaders(CONFIRM_HEADERS);
    const site = requireSite(locals);
    const token = (await request.formData()).get('token');
    if (typeof token !== 'string' || !token) redirect(303, outcomePath(site, 'invalid', undefined));
    let result;
    try {
      result = await runtime().invoker.run(
        useCases.confirmSubscription,
        anonymousPrincipal(siteTenant(site), ['forms:write']),
        { token }
      );
    } catch (e) {
      // Suspended between opening the page and pressing the button: the same answer as above.
      if (!(e instanceof UseCaseError && e.code === 'suspended')) throw e;
      const t = ui(answerLocale(site, request, null));
      return fail(403, { title: t('site.suspended.title'), body: t('site.suspended.body') });
    }
    redirect(303, outcomePath(site, result.status, result.locale));
  },
};
