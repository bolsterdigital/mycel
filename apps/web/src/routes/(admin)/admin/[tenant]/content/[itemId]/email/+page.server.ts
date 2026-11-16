// The e-mail preview of one item: the newsletter its latest revision would become, per
// locale, in a frame (lib/server/mail/email-preview.ts), with the subject and the text part
// beside it. Nothing is sent from here. Reading needs only `content:read`.
import { isUuid, pickAny, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { refuse } from '#lib/server/http/refuse.js';
import { emailFramePath, renderItemEmail } from '#lib/server/mail/email-preview.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params, url, cookies }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  if (!isUuid(params.itemId)) refuse(404);
  const { item, revision } = await loaded(
    runtime().invoker.run(useCases.getItem, principal, { itemId: params.itemId })
  );
  const locales = revision.document.locales.filter((l) => tenant.locales.includes(l));
  // The language being edited, as the edit screen picks it; else the item's own.
  const chosen = contentLocale(cookies, tenant, url.searchParams.get('locale'), locales);
  const work = locales.includes(chosen) ? chosen : item.defaultLocale;
  const email = await loaded(renderItemEmail(principal, tenant, item.id, work));
  return {
    contentType: item.type,
    item: { id: item.id, title: pickAny(item.title, work, item.defaultLocale) ?? '' },
    work,
    locales,
    subject: email.subject,
    text: email.text,
    frame: emailFramePath(tenant.slug, item.id, work),
  };
};
