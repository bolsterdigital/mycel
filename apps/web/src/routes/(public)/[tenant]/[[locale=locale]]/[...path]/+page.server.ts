// Every content path of a site (brief #8c § 8): pages, the homepage, articles and the thank-you
// page after a form post, with the locale prefix for a non-default locale. The grammar is
// `parseContentPath` (lib/server/content-route.ts); this file only turns it into a response, and
// runs the native form post of a page's form (ADR 009: works without JavaScript; validation
// happens on the server, in the core use case). The tenant is `locals.site` (hooks.server.ts):
// the hostname, or the dev path form; `params.tenant` is the slug the reroute hook put there and
// is never read (ADR 014). `confirm`, `media` and `_theme` are routes of their own and win over
// this one.
//
// Caching (§ 9): a published item is `public` with a strong ETag (hooks.server.ts answers the
// 304), except an item with a form, which is `no-store` without a validator so every visitor
// gets a fresh timing token (public-page.ts); a form post's answer and the thank-you page are
// `no-store`. No cookie is read or set.

import { error, fail, redirect } from '@sveltejs/kit';
import { anonymousPrincipal, contentPath, translate, useCases } from '@mycel/core';
import { currentContext } from '@mycel/observability';
import { ui } from '../../../../../i18n/index.js';
import { localeOf, parseContentPath, thanksPath } from '#lib/server/content-route.js';
import { failureFor } from '#lib/server/form-post.js';
import { NO_STORE, PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { loadPublicItem } from '#lib/server/public-page.js';
import { runtime } from '#lib/server/runtime.js';
import { absoluteSiteUrl, requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

/** The site, the item route and the locale of a request, or a 404. */
function target(locals: App.Locals, params: { locale?: string; path: string }) {
  const site = requireSite(locals);
  const route = parseContentPath(params.path);
  const locale = localeOf(params.locale, site.tenant);
  if (!route || !locale) error(404, 'Not found');
  return { site, route, locale };
}

export const load: PageServerLoad = async ({ params, locals, request, setHeaders }) => {
  const { site, route, locale } = target(locals, params);
  const view = await loadPublicItem(site, route, locale);
  locals.lang = locale;
  const t = ui(locale);

  if (route.thanks) {
    setHeaders({ 'cache-control': NO_STORE });
    const form = view.model.blocks.find((b) => b.type === 'form' && b.form);
    return {
      view: 'thanks' as const,
      title: view.model.title,
      message: form?.type === 'form' ? (form.form?.thankYou ?? '') : '',
      back: {
        href: sitePath(site, contentPath(view.item, locale, site.tenant.defaultLocale)),
        label: t('thanks.back'),
      },
    };
  }

  // A failed post re-renders the page with the visitor's answers: never for a shared cache.
  const read = request.method === 'GET' || request.method === 'HEAD';
  setHeaders(
    read && view.etag
      ? { etag: view.etag, 'cache-control': PUBLIC_CACHE }
      : { 'cache-control': NO_STORE }
  );
  return {
    view: 'item' as const,
    model: view.model,
    intro: view.intro,
    dropCap: view.dropCap,
    head: view.head,
    errorPrefix: t('error.prefix'),
  };
};

const text = (data: FormData, name: string): string => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

export const actions: Actions = {
  default: async ({ params, request, locals, getClientAddress }) => {
    const rt = runtime();
    const { site, route, locale } = target(locals, params);
    if (route.thanks) error(404, 'Not found');
    const { tenant } = site;
    const data = await request.formData();
    const formId = text(data, 'formId');

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
    const email = values['email'] ?? '';

    // Tenant from the site being visited, identity from the connection: nothing in the posted
    // body can choose a tenant or raise capabilities (ADR 002 rule 3). The locale is the path's.
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
        pageUrl: await absoluteSiteUrl(site, contentPath(route, locale, tenant.defaultLocale)),
        // An absent honeypot field is not an empty one: the core refuses a post without it.
        spam: {
          honeypot: data.has('website') ? text(data, 'website') : undefined,
          startedToken: text(data, '_started'),
          // Empty without JavaScript: the core then takes the stricter `unproven` route.
          proof: text(data, '_proof') || undefined,
        },
      });
    } catch (e) {
      const failure = failureFor(e, locale, currentContext().requestId ?? '-');
      if (failure.report === 'error') {
        rt.errors.capture(e, { tags: { operation: 'form.submit' } });
        rt.log.error('form.submit failed', { formId });
      } else if (failure.report === 'info') rt.log.info('form.submit malformed', { formId });
      return fail(failure.status, {
        formId,
        errors: [],
        message: failure.message,
        values: { email },
      });
    }

    // A tripped honeypot and a recipient in cooldown get the same thank-you as a person, so a
    // bot learns nothing, and nobody learns whether an address was just used.
    if (
      result.status === 'accepted' ||
      (result.status === 'rejected' &&
        (result.reason === 'spam' || result.reason === 'recipient-limited'))
    )
      redirect(303, sitePath(site, thanksPath(route, locale, tenant.defaultLocale)));

    if (result.status === 'invalid')
      return fail(400, {
        formId,
        errors: result.errors.map((e) => ({
          field: e.field,
          message: translate(locale, e.message),
        })),
        message: null,
        values: { email },
      });

    return fail(result.reason === 'rate-limited' ? 429 : 400, {
      formId,
      errors: [],
      message: translate(locale, result.message),
      values: { email },
    });
  },
};
