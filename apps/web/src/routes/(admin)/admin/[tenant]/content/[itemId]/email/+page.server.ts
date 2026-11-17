// The e-mail preview of one item: the newsletter its latest revision would become, per
// locale, in a frame (lib/server/mail/email-preview.ts), with the subject and the text part
// beside it. With `?edition=` the same page shows a sent edition as it went out, in the locales it
// went out in ("View as sent"). Nothing is sent from here. Reading needs only
// `content:read`.
import { isUuid, pickAny, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { refuse } from '#lib/server/http/refuse.js';
import { emailFramePath, renderItemEmail } from '#lib/server/mail/email-preview.js';
import { runtime } from '#lib/server/runtime.js';
import { adminTimeZone } from '#lib/server/admin/admin.js';
import { when } from '#lib/server/content/content-admin.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params, url, cookies }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  if (!isUuid(params.itemId)) refuse(404);
  const { invoker } = runtime();
  const { item, revision } = await loaded(
    invoker.run(useCases.getItem, principal, { itemId: params.itemId })
  );
  const asked = url.searchParams.get('edition');
  const sent = asked
    ? (await invoker.run(useCases.listEditions, principal, { itemId: item.id })).editions.find(
        (e) => e.id === asked
      )
    : null;
  if (asked && !sent) refuse(404);
  const locales = sent
    ? sent.locales.map((l) => l.locale)
    : revision.document.locales.filter((l) => tenant.locales.includes(l));
  // The language being edited, as the edit screen picks it; else the item's own.
  const chosen = contentLocale(cookies, tenant, url.searchParams.get('locale'), locales);
  const work = locales.includes(chosen) ? chosen : (locales[0] ?? item.defaultLocale);
  const email = await loaded(renderItemEmail(principal, tenant, item.id, work, sent?.id ?? null));
  const { zone } = await adminTimeZone(locals);
  return {
    edition: sent
      ? { id: sent.id, at: when(sent.sentAt, zone), recipients: sent.recipients }
      : null,
    contentType: item.type,
    item: { id: item.id, title: pickAny(item.title, work, item.defaultLocale) ?? '' },
    work,
    locales,
    subject: email.subject,
    text: email.text,
    frame: emailFramePath(tenant.slug, item.id, work, sent?.id ?? null),
  };
};
