// An article's newsletter in the admin: what the side panel of the edit screen and
// the send page show, and the outcomes their posts come back with. The settings themselves (list
// and subject) are fields of the editor's form and travel with a save (content-admin.ts); this
// file answers what can be sent now. That is always the published version: core makes the
// edition from the revision published in each locale (`mailing.edition.get`), so the panel asks
// core per published locale and shows the first refusal in words, not a guess of its own.
//
// `site` is derived here, on the server, from the tenant and its primary hostname
// (`adminSiteUrls`), never taken from a form: the links in a mail that goes to a whole list
// depend on it. Rejected: deriving it in core (it would need the platform's URL mode there) and
// rendering the mail on the edit screen itself (the panel needs a count and a reason, the send
// page shows the mail).

import {
  can,
  formDefinitionName,
  isUuid,
  useCases,
  type Principal,
  type UseCaseError,
} from '@mycel/core';
import { refusalOf } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { adminSiteUrls } from '../site.js';
import { when } from '../content/content-admin.js';
import type { UiKey } from '../../../i18n/index.js';

export interface NewsletterTenant {
  slug: string;
  name: string;
  defaultLocale: string;
}

/** What a post to the send page came back with, on the edit screen as `?newsletter=<outcome>`. */
export const NEWSLETTER_OUTCOMES = {
  tested: 'admin.email.outcome.tested',
  sent: 'admin.email.outcome.sent',
  'not-published': 'admin.email.refused.notPublished',
  restricted: 'admin.email.refused.restricted',
  'no-delivery': 'admin.email.refused.noDelivery',
  'no-subject': 'admin.email.refused.noSubject',
  'lists-differ': 'admin.email.refused.listsDiffer',
  limit: 'admin.email.refused.limit',
  forbidden: 'admin.error.forbidden',
  failed: 'admin.email.refused.other',
} as const satisfies Record<string, UiKey>;

export type NewsletterOutcome = keyof typeof NEWSLETTER_OUTCOMES;

export const newsletterOutcome = (value: string | null): NewsletterOutcome | null =>
  value && Object.hasOwn(NEWSLETTER_OUTCOMES, value) ? (value as NewsletterOutcome) : null;

/** The outcome a refusal of `mailing.edition.*` is named by: the issue core put first. */
export function refusalOutcome(e: UseCaseError): NewsletterOutcome {
  if (e.code === 'forbidden') return 'forbidden';
  if (e.code === 'limit_exceeded') return 'limit';
  const issue = e.issues[0]?.message ?? '';
  const named = issue.startsWith('mailing.edition.') ? issue.slice('mailing.edition.'.length) : '';
  return newsletterOutcome(named) ?? 'failed';
}

export async function emailSite(principal: Principal, tenant: NewsletterTenant) {
  const root = (await adminSiteUrls(principal, tenant.slug))('/').replace(/\/$/, '');
  return { name: tenant.name, url: root, defaultLocale: tenant.defaultLocale };
}

/** What a send would be now: per published locale its subject, the list and its count. */
export type SendState =
  | {
      ok: true;
      list: string;
      recipients: number;
      locales: { locale: string; subject: string }[];
    }
  | { ok: false; reason: NewsletterOutcome };

/**
 * The send `mailing.edition.send` would make of every published locale of the item. One locale
 * that core refuses refuses the send, as core would: its reason is the answer.
 */
export async function sendState(
  principal: Principal,
  tenant: NewsletterTenant,
  item: {
    id: string;
    publication: readonly { locale: string; publishedRevisionId: string | null }[];
  }
): Promise<SendState> {
  const published = item.publication.filter((p) => p.publishedRevisionId).map((p) => p.locale);
  if (!published.length) return { ok: false, reason: 'not-published' };
  const site = await emailSite(principal, tenant);
  const locales = [];
  let list = '';
  let recipients = 0;
  for (const locale of published) {
    try {
      const mail = await runtime().invoker.run(useCases.getEdition, principal, {
        itemId: item.id,
        locale,
        site,
      });
      if (list && mail.list !== list) return { ok: false, reason: 'lists-differ' };
      ({ list, recipients } = mail);
      locales.push({ locale, subject: mail.subject });
    } catch (e) {
      return { ok: false, reason: refusalOutcome(refusalOf(e)) };
    }
  }
  return { ok: true, list, recipients, locales };
}

/** The lists a site signs people up to: one per list, named after its first signup form. */
export async function signupLists(
  principal: Principal,
  locale: string
): Promise<{ id: string; label: string }[]> {
  if (!can(principal, 'content:write')) return [];
  const { forms } = await runtime().invoker.run(useCases.listForms, principal, {});
  const lists = new Map<string, string>();
  for (const form of forms)
    if (form.kind === 'signup' && !lists.has(form.list)) {
      const name = formDefinitionName(form, locale);
      lists.set(form.list, name !== form.list ? `${name} (${form.list})` : form.list);
    }
  return [...lists].map(([id, label]) => ({ id, label }));
}

export interface NewsletterPanel {
  lists: { id: string; label: string }[];
  /** Newest first: when, to how many, and where to read it as it went out. */
  editions: { at: string; recipients: number; delivering: boolean; href: string }[];
  /** May send (`mailing:send`); without it the settings show and the buttons do not. */
  canSend: boolean;
  send: SendState;
  /** Why nothing can be sent now, in words; null when it can. */
  blocked: UiKey | null;
  /** The send page, the e-mail preview and the hidden form's base (`<send>?/test`). */
  sendHref: string;
  previewHref: string;
}

/**
 * The side panel of an article's edit screen; null for anything else and when the item cannot be
 * read (the page load answers for that, as the campaign panel does).
 */
export async function newsletterPanel(
  principal: Principal,
  tenant: NewsletterTenant,
  itemId: string,
  /** The admin's language (list names), the language being edited and the admin's zone. */
  { ui, work, zone }: { ui: string; work: string; zone: string }
): Promise<NewsletterPanel | null> {
  if (!isUuid(itemId)) return null;
  const { invoker } = runtime();
  const item = await invoker
    .run(useCases.getItem, principal, { itemId })
    .then((r) => r.item)
    .catch((e: unknown) => {
      refusalOf(e);
      return null;
    });
  if (!item || item.type !== 'article') return null;
  const base = `/admin/${tenant.slug}/content/${item.id}/email`;
  const { editions } = await invoker.run(useCases.listEditions, principal, { itemId });
  const send = await sendState(principal, tenant, item);
  return {
    lists: await signupLists(principal, ui),
    editions: editions.map((e) => ({
      at: when(e.sentAt, zone),
      recipients: e.recipients,
      delivering: !e.completedAt,
      href: `${base}?${new URLSearchParams({
        edition: e.id,
        locale: (e.locales.find((l) => l.locale === work) ?? e.locales[0]!).locale,
      })}`,
    })),
    canSend: can(principal, 'mailing:send'),
    send,
    blocked: send.ok ? null : NEWSLETTER_OUTCOMES[send.reason],
    sendHref: `${base}/send`,
    previewHref: base,
  };
}
