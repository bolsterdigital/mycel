// A tenant page rendered from blocks, and the native form post for its signup block (ADR 009:
// works without JavaScript; validation happens on the server, in the core use case). The tenant
// is `locals.site` (hooks.server.ts): the hostname, or the dev path form; `params.tenant` is the
// slug the reroute hook put there and is never read (ADR 014).

import { fail, redirect } from '@sveltejs/kit';
import { UseCaseError, anonymousPrincipal, translate, useCases } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { loadPublicPage } from '#lib/server/public-page.js';
import { runtime } from '#lib/server/runtime.js';
import { absoluteSiteUrl, requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, locals }) => {
  const view = await loadPublicPage(
    requireSite(locals),
    params.slug,
    request.headers.get('accept-language')
  );
  locals.lang = view.locale;
  return { model: view.model, errorPrefix: ui(view.locale)('error.prefix') };
};

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

export const actions: Actions = {
  default: async ({ params, request, locals, getClientAddress }) => {
    const rt = runtime();
    const site = requireSite(locals);
    const { tenant } = site;
    const data = await request.formData();
    const formId = text(data, 'formId');
    const locale = text(data, 'locale') || tenant.defaultLocale;

    // Field values are read by name from the definition; the core validates them. Unchecked
    // checkboxes are absent from the post, which the core reads as "not given".
    const values: Record<string, string> = {};
    for (const [name, value] of data)
      if (
        typeof value === 'string' &&
        !name.startsWith('_') &&
        name !== 'formId' &&
        name !== 'locale' &&
        name !== 'website'
      )
        values[name] = value;

    // Tenant from the site being visited, identity from the connection: nothing in the posted
    // body can choose a tenant or raise capabilities (ADR 002 rule 3).
    const visitor = anonymousPrincipal(
      siteTenant(site),
      ['forms:write'],
      rt.signer.hashIp(getClientAddress())
    );
    let result;
    try {
      result = await rt.invoker.run(useCases.submitForm, visitor, {
        formId,
        values,
        locale,
        // Provenance in the site's canonical address (ADR 014 rule 6), not the request's.
        pageUrl: await absoluteSiteUrl(site, `/${params.slug}`),
        spam: { honeypot: text(data, 'website'), startedToken: text(data, '_started') },
      });
    } catch (e) {
      // The site takes no new signups (ADR 015 rules 3 and 7): no price, no host, just that.
      if (e instanceof UseCaseError && (e.code === 'limit_exceeded' || e.code === 'suspended'))
        return fail(403, {
          formId,
          errors: [],
          message: translate(locale, 'forms.rejected.closed'),
          values: { email: values['email'] ?? '' },
        });
      // Unknown or malformed formId: only a hand-crafted post gets here.
      return fail(400, {
        formId,
        errors: [],
        message: translate(locale, 'forms.error.required'),
        values,
      });
    }

    // A tripped honeypot gets the same thank-you as a person, so bots learn nothing.
    if (result.status === 'accepted' || (result.status === 'rejected' && result.reason === 'spam'))
      redirect(303, sitePath(site, `/${params.slug}/thanks`));

    if (result.status === 'invalid')
      return fail(400, {
        formId,
        errors: result.errors.map((e) => ({
          field: e.field,
          message: translate(locale, e.message),
        })),
        message: null,
        values: { email: values['email'] ?? '' },
      });

    return fail(result.reason === 'rate-limited' ? 429 : 400, {
      formId,
      errors: [],
      message: translate(locale, result.message),
      values: { email: values['email'] ?? '' },
    });
  },
};
