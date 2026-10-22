// Double opt-in landing page: the link from the confirmation mail runs `mailing.confirm` as the
// anonymous visitor of this tenant's site (ADR 010 rule 5). Each outcome is a page, not an
// error, so the visitor always gets a plain answer; the use case itself decides what the token
// is worth.
import { anonymousPrincipal, negotiateLocale, useCases, type ConfirmResult } from '@mycel/core';
import { ui, type UiKey } from '../../../../i18n/index.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';

const COPY: Record<ConfirmResult['status'], { title: UiKey; body: UiKey }> = {
  confirmed: { title: 'confirm.ok.title', body: 'confirm.ok.body' },
  already_confirmed: { title: 'confirm.already.title', body: 'confirm.already.body' },
  invalid: { title: 'confirm.invalid.title', body: 'confirm.invalid.body' },
};

export const load: PageServerLoad = async ({ url, request, locals }) => {
  const rt = runtime();
  const { tenant } = requireSite(locals);
  const locale = negotiateLocale(
    request.headers.get('accept-language'),
    tenant.locales,
    tenant.defaultLocale
  );
  locals.lang = locale;
  const token = url.searchParams.get('token') ?? '';
  const { status } = token
    ? await rt.invoker.run(
        useCases.confirmSubscription,
        anonymousPrincipal(tenant.id, ['forms:write']),
        {
          token,
        }
      )
    : { status: 'invalid' as const };
  const t = ui(locale);
  return { status, title: t(COPY[status].title), body: t(COPY[status].body) };
};
