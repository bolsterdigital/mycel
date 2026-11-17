// The unsubscribe page (ADR 010 rule 8): the link in a newsletter's footer opens it,
// and so does a GET of the `List-Unsubscribe` address (`one-click/`). Opening it only reads:
// `mailing.opt_out.get` says whether the token's supporter is still on its list, and if so the page
// shows one native form with one button. Only that form's POST runs `mailing.opt_out.confirm`, so
// a link scanner or a preview fetch unsubscribes nobody. A forged, expired or foreign token gets
// the same neutral page as any other invalid one.
//
// The answer to the post is rendered in place, not redirected like the double opt-in's: a second
// post is an idempotent outcome, and the form posts to the address without the token, so the
// address bar no longer holds it. Rejected: a tokenless outcome route per state (three more pages
// for what one rendered answer says), and unsubscribing on the GET (a scanner would do it).
//
// The form posts from the site's own origin and stays under the ordinary CSRF check; only the
// provider's one-click address is exempt (lib/server/http/csrf.ts).

import { fail } from '@sveltejs/kit';
import { anonymousPrincipal, useCases, type OptOutPreview, type OptOutResult } from '@mycel/core';
import { refusalOf } from '#lib/server/http/refuse.js';
import { CONFIRM_HEADERS, answerLocale } from '#lib/server/public/confirm.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import { ui, type UiKey } from '../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

type State = OptOutPreview['status'] | OptOutResult['status'];

const COPY: Record<State, { title: UiKey; body: UiKey }> = {
  subscribed: { title: 'unsubscribe.pending.title', body: 'unsubscribe.pending.body' },
  unsubscribed: { title: 'unsubscribe.ok.title', body: 'unsubscribe.ok.body' },
  already_unsubscribed: { title: 'unsubscribe.already.title', body: 'unsubscribe.already.body' },
  invalid: { title: 'unsubscribe.invalid.title', body: 'unsubscribe.invalid.body' },
};

/** One capability for both steps, the command's; the registry admits the visitor to these two. */
const visitor = (site: Parameters<typeof siteTenant>[0]) =>
  anonymousPrincipal(siteTenant(site), ['supporters:write']);

export const load: PageServerLoad = async ({ url, request, locals, setHeaders }) => {
  // The token is a credential: never stored, never sent on in a Referer (confirm.ts says why
  // `strict-origin` and not `no-referrer`).
  setHeaders(CONFIRM_HEADERS);
  const site = requireSite(locals);
  const token = url.searchParams.get('token') ?? '';
  const preview: OptOutPreview = token
    ? await runtime().invoker.run(useCases.previewOptOut, visitor(site), { token })
    : { status: 'invalid' };
  const locale = answerLocale(site, request, preview.locale);
  locals.lang = locale;
  const t = ui(locale);
  // A suspended site stays readable but changes nothing (ADR 015 rule 7): no button to press.
  const suspended = preview.status === 'subscribed' && site.access.status === 'suspended';
  const copy = suspended
    ? ({ title: 'site.suspended.title', body: 'site.suspended.body' } as const)
    : COPY[preview.status];
  const unsubscribe =
    preview.status === 'subscribed' && !suspended
      ? { action: sitePath(site, '/unsubscribe'), token, label: t('unsubscribe.pending.button') }
      : null;
  return { title: t(copy.title), body: t(copy.body), unsubscribe };
};

export const actions: Actions = {
  // No `setHeaders` here: `load` runs again after the action and sets them for its response.
  default: async ({ request, locals }) => {
    const site = requireSite(locals);
    const token = (await request.formData()).get('token');
    let result: OptOutResult = { status: 'invalid' };
    try {
      if (typeof token === 'string' && token)
        result = await runtime().invoker.run(useCases.confirmOptOut, visitor(site), {
          token,
          via: 'page',
        });
    } catch (e) {
      // Suspended between opening the page and pressing the button: the same answer as above.
      if (refusalOf(e).code !== 'suspended') throw e;
      const t = ui(answerLocale(site, request, null));
      return fail(403, { title: t('site.suspended.title'), body: t('site.suspended.body') });
    }
    const locale = answerLocale(site, request, result.locale);
    locals.lang = locale;
    const t = ui(locale);
    const copy = COPY[result.status];
    return { title: t(copy.title), body: t(copy.body) };
  },
};
