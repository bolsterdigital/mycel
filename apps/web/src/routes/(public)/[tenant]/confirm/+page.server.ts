// Double opt-in landing page. PROBE STUB: it verifies the signed link but records nothing yet.
// The real version is a `mailing.confirm` use case that emits `consent.given` (ADR 003 rule 4).
import { negotiateLocale, verifyConfirmToken } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { tenantBySlug } from '#lib/server/public-page.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, request, locals }) => {
  const rt = runtime();
  const tenant = await tenantBySlug(params.tenant);
  const locale = negotiateLocale(
    request.headers.get('accept-language'),
    tenant.locales,
    tenant.defaultLocale
  );
  locals.lang = locale;
  const payload = await verifyConfirmToken(
    rt.signer,
    url.searchParams.get('token') ?? '',
    rt.clock.now()
  );
  const ok = payload !== null && payload.tenantId === tenant.id;
  const t = ui(locale);
  return {
    ok,
    title: t(ok ? 'confirm.ok.title' : 'confirm.invalid.title'),
    body: t(ok ? 'confirm.ok.body' : 'confirm.invalid.body'),
  };
};
