// Sending an article as a newsletter: the confirmation step and the two posts. The
// page names what a send would be now (lib/server/mail/newsletter.ts): the list, how many
// confirmed subscribers it has, the published languages and their subjects. Its form posts
// exactly those languages to `send`; `test` sends one language to the operator's own address and
// is also posted from the edit screen's side panel. Both come back to the edit screen with
// `?newsletter=<outcome>`, where the panel says what happened and lists the edition; `test` from
// this page comes back here (`back=send`). Core refuses whatever may not be sent; this page only
// asks first. Rejected: a confirm dialog (needs JavaScript) and a confirm step inside the edit
// screen's form (it would post the whole editor to send a mail).
import { redirect } from '@sveltejs/kit';
import { can, isUuid, pickAny, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { refusalOf, refuse } from '#lib/server/http/refuse.js';
import {
  NEWSLETTER_OUTCOMES,
  emailSite,
  refusalOutcome,
  sendState,
  signupLists,
  type NewsletterOutcome,
} from '#lib/server/mail/newsletter.js';
import { runtime } from '#lib/server/runtime.js';
import { langOf } from '../../../../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  if (!isUuid(params.itemId)) refuse(404);
  if (!can(principal, 'mailing:send')) refuse(403);
  const { item } = await loaded(
    runtime().invoker.run(useCases.getItem, principal, { itemId: params.itemId })
  );
  if (item.type !== 'article') refuse(404);
  const work = url.searchParams.get('locale') ?? item.defaultLocale;
  const send = await sendState(principal, tenant, item);
  const lists = await signupLists(principal, langOf(locals));
  return {
    item: { id: item.id, title: pickAny(item.title, work, item.defaultLocale) ?? '' },
    work,
    send,
    blocked: send.ok ? null : NEWSLETTER_OUTCOMES[send.reason],
    listLabel: send.ok ? (lists.find((l) => l.id === send.list)?.label ?? send.list) : '',
    edit: `/admin/${tenant.slug}/content/${item.id}?${new URLSearchParams({ locale: work })}`,
    // Who the count is, for a reader of `supporters:read` (MY-251): the list with this filter.
    recipientsHref:
      send.ok && can(principal, 'supporters:read')
        ? `/admin/${tenant.slug}/supporters?${new URLSearchParams({ list: send.list, status: 'confirmed' })}`
        : null,
  };
};

/** Back to where the post came from, with what happened. */
function back(url: URL, slug: string, itemId: string, outcome: NewsletterOutcome): never {
  const locale = url.searchParams.get('locale') ?? '';
  const query = new URLSearchParams({ newsletter: outcome, ...(locale ? { locale } : {}) });
  const path = `/admin/${slug}/content/${itemId}`;
  redirect(
    303,
    url.searchParams.get('back') === 'send' ? `${path}/email/send?${query}` : `${path}?${query}`
  );
}

/** Run one send use case; a refusal becomes its outcome, anything else stays an error. */
async function attempt(fn: () => Promise<unknown>): Promise<NewsletterOutcome | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return refusalOutcome(refusalOf(e));
  }
}

export const actions: Actions = {
  test: async ({ locals, url, params }) => {
    if (!isUuid(params.itemId)) refuse(404);
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const locale = url.searchParams.get('locale') ?? tenant.defaultLocale;
    const site = await emailSite(principal, tenant);
    const refused = await attempt(() =>
      runtime().invoker.run(useCases.testEdition, principal, {
        itemId: params.itemId,
        locale,
        site,
      })
    );
    back(url, tenant.slug, params.itemId, refused ?? 'tested');
  },
  send: async ({ locals, url, params, request }) => {
    if (!isUuid(params.itemId)) refuse(404);
    const { tenant, principal } = await requireTenantPrincipal(locals, url, params.tenant);
    const locales = (await request.formData()).getAll('locales').map(String);
    const site = await emailSite(principal, tenant);
    const refused = await attempt(() =>
      runtime().invoker.run(useCases.sendEdition, principal, {
        itemId: params.itemId,
        locales,
        site,
      })
    );
    // A refusal on this page is shown on this page, so the editor sees it beside what they sent.
    if (refused) url.searchParams.set('back', 'send');
    else url.searchParams.delete('back');
    back(url, tenant.slug, params.itemId, refused ?? 'sent');
  },
};
