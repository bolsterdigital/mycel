// Every content path of a site (brief #8c § 8): pages, the homepage, articles and the thank-you
// page after a form post, with the locale prefix for a non-default locale. The grammar is
// `parseContentPath` (lib/server/public/content-route.ts); this file only turns it into a response, and
// runs the native form post of a page's form (ADR 009: works without JavaScript; validation
// happens on the server, in the core use case). The tenant is `locals.site` (hooks.server.ts):
// the hostname, or the dev path form; `params.tenant` is the slug the reroute hook put there and
// is never read (ADR 014). `confirm`, `media` and `_theme` are routes of their own and win over
// this one. A path that serves nothing may be an item's old address (`forwardOldAddress`).
//
// Caching (§ 9): a published item is `public` with a strong ETag (hooks.server.ts answers the
// 304), except an item with a form, which is `no-store` without a validator so every visitor
// gets a fresh timing token (public-page.ts); a form post's answer and the thank-you page are
// `no-store`. A public item reads no cookie. A restricted item reads the reader cookie, varies
// on it, and answers a request that carries one `private, no-store` (`itemCacheHeaders`).

import { fail, isHttpError, redirect } from '@sveltejs/kit';
import {
  OVERVIEW_MAX_PAGE,
  anonymousPrincipal,
  contentPath,
  translate,
  useCases,
} from '@mycel/core';
import { currentContext } from '@mycel/observability';
import { ui } from '../../../../../i18n/index.js';
import {
  donationPath,
  localeOf,
  parseContentPath,
  thanksPath,
} from '#lib/server/public/content-route.js';
import { failureFor } from '#lib/server/public/form-post.js';
import { NO_STORE, itemCacheHeaders } from '#lib/server/http/http-cache.js';
import { forwardOldAddress } from '#lib/server/public/old-address.js';
import { loadPublicItem } from '#lib/server/public/public-page.js';
import { pageviewTag } from '#lib/server/public/scripts/analytics.js';
import { pagePlacement } from '#lib/server/public/scripts/integrations.js';
import { runtime } from '#lib/server/runtime.js';
import { absoluteSiteUrl, requireSite, sitePath, siteTenant } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';
import { refuse } from '#lib/server/http/refuse.js';

/** The site, the item route and the locale of a request, or a 404. */
function target(locals: App.Locals, params: { locale?: string; path: string }) {
  const site = requireSite(locals);
  const route = parseContentPath(params.path);
  const locale = localeOf(params.locale, site.tenant);
  if (!route || !locale) refuse(404);
  return { site, route, locale };
}

/**
 * The page of an overview's archive (`?p=2`): absent is 1; anything but 2 to 100 in plain
 * digits is a 404, so one list has one address per page.
 */
function pageOf(url: URL): number {
  const p = url.searchParams.get('p');
  if (p === null) return 1;
  if (!/^[1-9]\d{0,2}$/.test(p) || Number(p) < 2 || Number(p) > OVERVIEW_MAX_PAGE) refuse(404);
  return Number(p);
}

export const load: PageServerLoad = async ({
  params,
  locals,
  request,
  setHeaders,
  url,
  cookies,
}) => {
  const { site, route, locale } = target(locals, params);
  const view = await loadPublicItem(
    site,
    route,
    locale,
    route.thanks ? 1 : pageOf(url),
    cookies
  ).catch(async (e: unknown) => {
    // Nothing published here: an old address of an item forwards to it.
    if (isHttpError(e, 404) && !route.thanks)
      await forwardOldAddress(site, route, locale, url, setHeaders);
    throw e;
  });
  locals.lang = locale;
  const t = ui(locale);

  if (route.thanks) {
    setHeaders({ 'cache-control': NO_STORE });
    // The first form on the page; a `full` campaign card's form counts (ADR 033 rule 4), and so
    // does one in the pre-footer zone, where a newsletter form usually stands.
    const blocks = [...view.model.blocks, ...(view.prefooter?.model.blocks ?? [])];
    const form = blocks.flatMap((b) =>
      (b.type === 'form' || b.type === 'campaign-card') && b.form ? [b.form] : []
    )[0];
    return {
      view: 'thanks' as const,
      title: view.model.title,
      message: form?.thankYou ?? '',
      back: {
        href: sitePath(site, contentPath(view.item, locale, site.tenant.defaultLocale)),
        label: t('thanks.back'),
      },
    };
  }

  // A failed post re-renders the page with the visitor's answers: never for a shared cache.
  const read = request.method === 'GET' || request.method === 'HEAD';
  setHeaders(itemCacheHeaders(read ? view : { ...view, etag: null }));
  // The players this page may load on a click, the tag manager it may load after consent, and
  // their origins for the CSP (integrations.ts).
  const response = { method: request.method, status: 200, url, thanks: false };
  const blocks = [...view.model.blocks, ...(view.prefooter?.model.blocks ?? [])];
  const { embeds, consent, sources } = await pagePlacement(
    site,
    response,
    view.item,
    locale,
    blocks
  );
  if (sources) locals.pageSources = sources;
  return {
    view: 'item' as const,
    model: view.model,
    prefooter: view.prefooter,
    dossiers: view.dossiers,
    gate: view.gate,
    intro: view.intro,
    corrections: view.corrections,
    dropCap: view.dropCap,
    head: view.head,
    structured: view.structured,
    // Only a successful GET of a published public item counts (analytics.ts).
    pageview: await pageviewTag(site, response, view.item, locale),
    embeds,
    consent,
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
    if (route.thanks) refuse(404);
    const { tenant } = site;
    const data = await request.formData();
    const formId = text(data, 'formId');

    // Field values are read by name from the definition; the core validates them. Unchecked
    // checkboxes are absent from the post, which the core reads as "not given".
    const values: Record<string, string | string[]> = {};
    for (const [name, value] of data)
      if (
        typeof value === 'string' &&
        !name.startsWith('_') &&
        name !== 'formId' &&
        name !== 'locale' &&
        name !== 'website'
      )
        values[name] =
          data.getAll(name).length > 1
            ? data.getAll(name).filter((v): v is string => typeof v === 'string')
            : value;

    // Tenant from the site being visited, identity from the connection: nothing in the posted
    // body can choose a tenant or raise capabilities (ADR 002 rule 3). The locale is the path's.
    const visitor = anonymousPrincipal(
      siteTenant(site),
      ['forms:write'],
      rt.signer.hashIp(getClientAddress())
    );
    const here = contentPath(route, locale, tenant.defaultLocale);
    let result;
    try {
      result = await rt.invoker.run(useCases.submitForm, visitor, {
        formId,
        formVersion: text(data, '_formVersion') || undefined,
        values,
        locale,
        // Provenance in the site's canonical address (ADR 014 rule 6), not the request's.
        pageUrl: await absoluteSiteUrl(site, here),
        // Only a donation form reads it: where the provider sends the visitor back, in the
        // page's locale, with the page to try again from (`donation/[token]`).
        returnUrl: `${await absoluteSiteUrl(site, donationPath(locale, tenant.defaultLocale))}{token}?back=${encodeURIComponent(here)}`,
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
        values,
      });
    }

    // A gift goes to its return page, which sends the visitor on to the provider's checkout
    // (`?pay=1`): CSP `form-action 'self'` refuses a form post that redirects to another origin,
    // and a provider's checkout is one. One the provider settled at once shows its outcome.
    if (result.status === 'accepted' && result.token !== undefined)
      redirect(
        303,
        sitePath(
          site,
          `${donationPath(locale, tenant.defaultLocale)}${encodeURIComponent(result.token)}?${new URLSearchParams({ ...(result.checkoutUrl ? { pay: '1' } : {}), back: here })}`
        )
      );

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
        values,
      });

    return fail(
      result.reason === 'unavailable' ? 503 : result.reason === 'rate-limited' ? 429 : 400,
      {
        formId,
        errors: [],
        message: translate(locale, result.message),
        values,
      }
    );
  },
};
