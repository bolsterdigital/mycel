// The giver's mails about a monthly or yearly gift (brief MY-254 PR 3): the link they asked for,
// and a notice when the gift started, when a charge failed, when dunning ended it and when it was
// stopped. Both kinds of outbox event name a supporter or a subscription and the facts the mail
// states, never an address or a token; this source reads the address when it builds the message
// and signs the link again (deterministic, with the event's time plus the link's lifetime as its
// expiry), so the `mail.reconcile` job rebuilds exactly what the subscriber sent.
//
// The source dries up on its own: an erased or unknown giver, a suspended site and a link past its
// week give no message. Transactional stream, no list headers: the mails are about money the
// person gives, and none of them puts anyone on a list.
// Rejected: a mail per notice kind as its own subscriber (four copies of the same reading), and
// the amount read from the subscription when sending (a later change would make the reconcile
// build another message than the one that went out).

import { t, type MessageKey } from '../i18n/index.js';
import type { ConfirmationMailDeps } from '../mailing/confirmation.js';
import type { MailAddress, MailMessage } from '../mailing/ports.js';
import { sendOnce, type MailSource } from '../mailing/send-attempts.js';
import type { DomainEvent, Subscriber } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { isTombstone } from '../supporters/erasure.js';
import '../supporters/ports.js';
import { siteUrl } from '../tenants/url.js';
import '../theme/ports.js';
import { DEFAULT_TIME_ZONE } from '../util/time-zone.js';
import {
  GIVING_NOTICE,
  GivingNoticeProps,
  SELF_LINK_REQUESTED,
  SELF_LINK_TTL_MS,
  SELF_PATH,
  selfToken,
  type GivingNoticeKind,
  type SelfLinkRequestedProps,
} from './self-service-model.js';

export const GIVING_MAIL_SUBSCRIBER = 'donation.giving.mail';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `€ 10` and `€ 12,50` in the giver's language, as the site writes them (apps/web money.ts). */
export function formatAmount(locale: string, amount: number, currency: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);
}

type Kind = GivingNoticeKind | 'link';

const SUBJECT: Record<Kind, MessageKey> = {
  link: 'mail.giving.link.subject',
  started: 'mail.giving.started.subject',
  'charge-failed': 'mail.giving.failed.subject',
  ended: 'mail.giving.ended.subject',
  cancelled: 'mail.giving.cancelled.subject',
};

export interface GivingMailInput {
  kind: Kind;
  locale: string;
  tenantName: string;
  from: MailAddress;
  to: string;
  /** The page with the gifts; for `link`, `started` and `charge-failed`. */
  manageUrl: string | null;
  /** Where to ask for a new link once this one is old. */
  requestUrl: string;
  /** The amount per interval (`€ 10 per maand`), for the notices. */
  gift: { amount: string; interval: 'month' | 'year' } | null;
  /** The next attempt, as a date in the site's time zone, for `charge-failed`. */
  nextAttempt: string | null;
  /** A membership's notice (PR 4): its own words, and for a cancelled one the day it stops. */
  membership?: { until: string | null } | null;
}

/** A membership says "membership" where a gift says "gift". */
const MEMBER_SUBJECT: Record<GivingNoticeKind, MessageKey> = {
  started: 'mail.membership.started.subject',
  'charge-failed': 'mail.membership.failed.subject',
  ended: 'mail.membership.ended.subject',
  cancelled: 'mail.membership.cancelled.subject',
};

export function renderGivingMail(input: GivingMailInput): MailMessage {
  const { kind, locale } = input;
  const params: Record<string, string> = {
    tenant: input.tenantName,
    amount: input.gift?.amount ?? '',
    per: input.gift ? t(locale, `mail.giving.per.${input.gift.interval}`) : '',
    date: input.nextAttempt ?? '',
    until: input.membership?.until ?? '',
    url: input.requestUrl,
  };
  const m = (key: MessageKey) => t(locale, key, params);
  const member = input.membership && kind !== 'link' ? kind : null;
  const subject = m(member ? MEMBER_SUBJECT[member] : SUBJECT[kind]);
  const paragraphs: string[] = [];
  if (member === 'started') paragraphs.push(m('mail.membership.started.intro'));
  else if (member === 'charge-failed')
    paragraphs.push(
      m('mail.membership.failed.intro'),
      m(input.nextAttempt ? 'mail.giving.failed.retry' : 'mail.giving.failed.later')
    );
  else if (member === 'ended')
    paragraphs.push(m('mail.membership.ended.intro'), m('mail.membership.again'));
  else if (member === 'cancelled')
    paragraphs.push(
      m(
        input.membership?.until
          ? 'mail.membership.cancelled.until'
          : 'mail.membership.cancelled.intro'
      ),
      m('mail.giving.thanks')
    );
  else
    switch (kind) {
      case 'link':
        paragraphs.push(m('mail.giving.link.intro'));
        break;
      case 'started':
        paragraphs.push(m('mail.giving.started.intro'));
        break;
      case 'charge-failed':
        paragraphs.push(
          m('mail.giving.failed.intro'),
          m(input.nextAttempt ? 'mail.giving.failed.retry' : 'mail.giving.failed.later')
        );
        break;
      case 'ended':
        paragraphs.push(m('mail.giving.ended.intro'), m('mail.giving.again'));
        break;
      case 'cancelled':
        paragraphs.push(m('mail.giving.cancelled.intro'), m('mail.giving.thanks'));
        break;
    }
  const after: string[] = [];
  if (input.manageUrl) after.push(m('mail.giving.expires'));
  if (kind === 'link') after.push(m('mail.signin.ignore'));

  const text = [
    ...paragraphs.flatMap((p) => [p, '']),
    ...(input.manageUrl ? [input.manageUrl, ''] : []),
    ...after,
  ]
    .join('\n')
    .trimEnd();
  const url = input.manageUrl ? escapeHtml(input.manageUrl) : null;
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:36rem;padding:1.5rem">
    <h1 style="font-size:1.25rem">${escapeHtml(subject)}</h1>
${paragraphs.map((p) => `    <p>${escapeHtml(p)}</p>`).join('\n')}
${
  url
    ? `    <p><a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:.75rem 1.25rem;border-radius:.5rem;text-decoration:none">${escapeHtml(m(member ? 'mail.membership.button' : 'mail.giving.button'))}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.fallback'))}<br><a href="${url}" style="color:#52525b">${url}</a></p>`
    : ''
}
${after.length ? `    <p style="font-size:.875rem;color:#52525b">${after.map(escapeHtml).join(' ')}</p>` : ''}
  </body>
</html>`;
  return {
    from: input.from,
    to: { email: input.to },
    subject,
    text,
    html,
    stream: 'transactional',
  };
}

/** The notices that carry the link to the page; a gift that stopped has nothing to manage. */
const WITH_LINK: readonly Kind[] = ['link', 'started', 'charge-failed'];

/** The message for a link request or a notice, or null once there is nobody or nothing to send. */
export function givingMailSource(deps: ConfirmationMailDeps): MailSource {
  return async (event: DomainEvent) => {
    let kind: Kind;
    let supporterId: string | null = null;
    let subscriptionId: string | null = null;
    let locale: string;
    let notice: GivingNoticeProps | null = null;
    if (event.type === SELF_LINK_REQUESTED) {
      const p = event.props as unknown as SelfLinkRequestedProps;
      if (typeof p.supporterId !== 'string' || typeof p.locale !== 'string') return null;
      kind = 'link';
      supporterId = p.supporterId;
      locale = p.locale;
    } else if (event.type === GIVING_NOTICE) {
      const parsed = GivingNoticeProps.safeParse(event.props);
      if (!parsed.success) return null;
      notice = parsed.data;
      kind = notice.notice;
      subscriptionId = notice.subscriptionId;
      locale = notice.locale;
    } else return null;
    if (deps.access && (await deps.access(event.tenantId)).status === 'suspended') return null;

    const expiresAt = new Date(event.occurredAt.getTime() + SELF_LINK_TTL_MS);
    if (WITH_LINK.includes(kind) && expiresAt.getTime() <= deps.clock.now().getTime()) return null;

    const system = systemPrincipal(event.tenantId, GIVING_MAIL_SUBSCRIBER);
    // The giver's address, the primary hostname and the time zone are the tenant's rows, read
    // under its RLS; the address is the only fact of the person, and only here.
    const read = await deps.uow.run(system, async (ctx) => {
      const sub = subscriptionId ? await ctx.subscriptions.get(subscriptionId) : null;
      const id = supporterId ?? sub?.supporterId ?? null;
      const giver = id ? await ctx.supporters.getProjectionById(id) : null;
      return {
        giver,
        primary: await ctx.hostnames.primary(),
        timeZone: (await ctx.siteSettings.general()).value.timeZone ?? DEFAULT_TIME_ZONE,
      };
    });
    const giver = read.giver;
    if (!giver || isTombstone(giver.email)) return null;
    const tenant = await deps.tenants.findById(event.tenantId);
    if (!tenant) throw new Error(`tenant ${event.tenantId} not found`);
    // Always the primary hostname (ADR 014 rule 6): the host the request came in on plays no part.
    const at = (path: string) =>
      siteUrl(
        { slug: tenant.slug, primaryHostname: read.primary?.hostname ?? null },
        deps.platform,
        path
      );
    const manageUrl = WITH_LINK.includes(kind)
      ? at(
          // The page opens in the mail's language (`lang`), not the browser's.
          `${SELF_PATH}/${encodeURIComponent(await selfToken(deps.signer, tenant.id, giver.id, expiresAt))}?lang=${encodeURIComponent(locale)}`
        )
      : null;
    const day = (iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: read.timeZone }).format(
        new Date(iso)
      );
    const nextAttempt = notice?.nextChargeAt ? day(notice.nextChargeAt) : null;
    return renderGivingMail({
      kind,
      locale,
      tenantName: tenant.name,
      from: deps.from,
      to: giver.email,
      manageUrl,
      requestUrl: at(SELF_PATH),
      gift: notice
        ? {
            amount: formatAmount(locale, notice.amount, notice.currency),
            interval: notice.interval,
          }
        : null,
      nextAttempt,
      membership:
        notice?.kind === 'membership'
          ? { until: notice.paidThrough ? day(notice.paidThrough) : null }
          : null,
    });
  };
}

/** Sends after commit, from the outbox, once per event (`sendOnce`). */
export function givingMailSubscriber(deps: ConfirmationMailDeps): Subscriber {
  const source = givingMailSource(deps);
  return {
    name: GIVING_MAIL_SUBSCRIBER,
    types: [SELF_LINK_REQUESTED, GIVING_NOTICE],
    async handle(event) {
      const message = await source(event);
      if (message) await sendOnce(deps, event, GIVING_MAIL_SUBSCRIBER, message);
    },
  };
}
