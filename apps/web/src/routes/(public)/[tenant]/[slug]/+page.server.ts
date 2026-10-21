// A tenant page rendered from blocks, and the native form post for its signup block (ADR 009:
// works without JavaScript; validation happens on the server, in the core use case).

import { fail, redirect } from '@sveltejs/kit';
import { anonymousPrincipal, translate, useCases } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { loadPublicPage, tenantBySlug } from '#lib/server/public-page.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, locals }) => {
  const view = await loadPublicPage(
    params.tenant,
    params.slug,
    request.headers.get('accept-language')
  );
  locals.lang = view.locale;
  const t = ui(view.locale);
  return {
    locale: view.locale,
    title: view.title,
    blocks: view.blocks,
    copy: {
      errorPrefix: t('error.prefix'),
      summaryTitle: t('error.summary.title'),
      honeypotLabel: t('form.honeypot.label'),
    },
  };
};

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

export const actions: Actions = {
  default: async ({ params, request, url, getClientAddress }) => {
    const rt = runtime();
    const tenant = await tenantBySlug(params.tenant);
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

    // Tenant from the route (the site being visited), identity from the connection: nothing in
    // the posted body can choose a tenant or raise capabilities (ADR 002 rule 3).
    const visitor = anonymousPrincipal(
      tenant.id,
      ['forms:write'],
      rt.signer.hashIp(getClientAddress())
    );
    let result;
    try {
      result = await rt.invoker.run(useCases.submitForm, visitor, {
        formId,
        values,
        locale,
        pageUrl: `${url.origin}${url.pathname}`,
        spam: { honeypot: text(data, 'website'), startedToken: text(data, '_started') },
      });
    } catch {
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
      redirect(303, `/${params.tenant}/${params.slug}/thanks`);

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
