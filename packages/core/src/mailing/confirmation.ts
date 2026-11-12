// Double opt-in confirmation mail (ADR 010 rule 5). Copy comes from the domain catalogs in the
// recipient's locale (ADR 007 rule 5); markup is minimal table-free HTML plus a text part. The
// e-mail block renderer replaces `renderConfirmationMail` once templates are block documents.

import type { ResolvedFormMail } from '../forms/mail-model.js';
import { PARTICIPATION_REQUESTED, type NewsletterSubscribedProps } from '../forms/events.js';
import { t } from '../i18n/index.js';
import type { Clock, Signer, Subscriber, UnitOfWork } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import type { PlatformConfig, TenantDirectory } from '../tenants/ports.js';
import { siteUrl } from '../tenants/url.js';
import { sendOnce, type DeliveryDeps, type MailSource } from './send-attempts.js';
import type { MailAddress, MailMessage, Mailer } from './ports.js';

const CONFIRM_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface ConfirmPayload {
  tenantId: string;
  submissionId: string;
  list: string;
  exp: number;
}

/** Tokens carry opaque ids only, never the address, so a leaked link discloses nothing. */
export function signConfirmToken(
  signer: Signer,
  fields: Omit<ConfirmPayload, 'exp'>,
  now: Date
): Promise<string> {
  const payload: ConfirmPayload = { ...fields, exp: now.getTime() + CONFIRM_TTL_MS };
  return signer.sign(JSON.stringify(payload));
}

export async function verifyConfirmToken(
  signer: Signer,
  token: string,
  now: Date
): Promise<ConfirmPayload | null> {
  const raw = await signer.verify(token);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ConfirmPayload>;
    if (
      typeof p.tenantId !== 'string' ||
      typeof p.submissionId !== 'string' ||
      typeof p.list !== 'string' ||
      typeof p.exp !== 'number' ||
      p.exp < now.getTime()
    )
      return null;
    return p as ConfirmPayload;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderConfirmationMail(input: {
  locale: string;
  tenantName: string;
  confirmUrl: string;
  from: MailAddress;
  to: string;
  copy?: ResolvedFormMail;
  /** A campaign participation confirms an address, not a subscription (ADR 033 rule 7). */
  purpose?: 'subscription' | 'participation';
}): MailMessage {
  const { locale, tenantName, confirmUrl } = input;
  const m = (key: Parameters<typeof t>[1]) => t(locale, key, { tenant: tenantName });
  const own = input.purpose === 'participation';
  const intro =
    input.copy?.text ?? m(own ? 'mail.confirm.participation.intro' : 'mail.confirm.intro');
  const subject =
    input.copy?.subject ?? m(own ? 'mail.confirm.participation.subject' : 'mail.confirm.subject');
  const heading = m(own ? 'mail.confirm.participation.heading' : 'mail.confirm.heading');
  const button = m(own ? 'mail.confirm.participation.button' : 'mail.confirm.button');
  const text = [intro, '', confirmUrl, '', m('mail.confirm.ignore')].join('\n');
  const url = escapeHtml(confirmUrl);
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:36rem;padding:1.5rem">
    <h1 style="font-size:1.25rem">${escapeHtml(heading)}</h1>
    <p>${escapeHtml(intro)}</p>
    <p><a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:.75rem 1.25rem;border-radius:.5rem;text-decoration:none">${escapeHtml(button)}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.fallback'))}<br><a href="${url}" style="color:#52525b">${url}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.ignore'))}</p>
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

export interface ConfirmationMailDeps {
  mailer: Mailer;
  signer: Signer;
  clock: Clock;
  tenants: TenantDirectory;
  /** The intent row is tenant data and is written under RLS, like any use case (ADR 011 rule 3). */
  uow: UnitOfWork;
  from: MailAddress;
  /** The link is `siteUrl(tenant, '/confirm?token=...')` on the tenant's primary hostname (ADR 014 rule 6). */
  platform: Pick<PlatformConfig, 'platformOrigin' | 'siteUrlMode'>;
  access?: (tenantId: string) => Promise<import('../entitlements/model.js').TenantAccess>;
  reconcileLagMs?: DeliveryDeps['reconcileLagMs'];
}

export const CONFIRMATION_SUBSCRIBER = 'mailing.confirmation';

/**
 * The confirmation for a `newsletter.subscribed` or `campaign.participation.requested` event, or
 * null when the submission needs none. A participation confirms the address for a campaign and
 * grants no list, so the external consent owner and list withdrawals do not stop it. Pure
 * apart from signing and reading the primary hostname, so the `mail.reconcile` job rebuilds the
 * same recipient and subject from the outbox event (the token is signed afresh).
 */
export function confirmationMailSource(deps: ConfirmationMailDeps): MailSource {
  return async (event) => {
    const p = event.props as unknown as NewsletterSubscribedProps;
    const participation = event.type === PARTICIPATION_REQUESTED;
    if (p.confirmed) return null;
    if (deps.access && (await deps.access(event.tenantId)).status === 'suspended') return null;
    if (
      !p.formVersion &&
      (await deps.uow.run(systemPrincipal(event.tenantId, CONFIRMATION_SUBSCRIBER), async (ctx) =>
        (await ctx.formFeeds.get()).value.feeds.some(
          (f) => f.enabled && f.scope === p.list && f.confirmationOwner === 'external'
        )
      ))
    )
      return null;
    if (p.formVersion) {
      const allowed = await deps.uow.run(
        systemPrincipal(event.tenantId, CONFIRMATION_SUBSCRIBER),
        async (ctx) => {
          const sub = await ctx.submissions.findById(p.submissionId);
          // Each mail waits on its own fact: the signature's link is still owed after an external
          // owner confirmed consent, and the other way round.
          const done = participation ? sub?.participationConfirmedAt : sub?.confirmedAt;
          if (!sub || done || sub.evaluation?.version !== p.formVersion) return false;
          if (
            p.confirmationVersion &&
            sub.evaluation?.confirmationMail?.version !== p.confirmationVersion
          )
            return false;
          if (participation) return !!sub.evaluation?.campaignId;
          if (
            (await ctx.formFeeds.get()).value.feeds.some(
              (f) => f.enabled && f.scope === sub.list && f.confirmationOwner === 'external'
            )
          )
            return false;
          if (sub.evaluation?.feedActions?.some((p) => p.feed.confirmationOwner === 'external'))
            return false;
          const projection = await ctx.supporters.getProjection(p.email);
          if (!projection) return true;
          const history = await ctx.supporters.eventsFor(projection.id);
          return !history.some(
            (e) =>
              ['consent.withdrawn', 'newsletter.unsubscribed'].includes(e.type) &&
              e.props['list'] === p.list &&
              new Date(e.occurred_at) >= sub.createdAt
          );
        }
      );
      if (!allowed) return null;
    }
    const tenant = await deps.tenants.findById(event.tenantId);
    if (!tenant) throw new Error(`tenant ${event.tenantId} not found`);
    const token = await signConfirmToken(
      deps.signer,
      { tenantId: tenant.id, submissionId: p.submissionId, list: p.list },
      deps.clock.now()
    );
    // The primary hostname is the tenant's own data, read under its RLS like the intent row.
    const primary = await deps.uow.run(systemPrincipal(tenant.id, CONFIRMATION_SUBSCRIBER), (ctx) =>
      ctx.hostnames.primary()
    );
    const confirmUrl = siteUrl(
      { slug: tenant.slug, primaryHostname: primary?.hostname ?? null },
      deps.platform,
      `/confirm?token=${encodeURIComponent(token)}`
    );
    return renderConfirmationMail({
      locale: p.locale,
      tenantName: tenant.name,
      confirmUrl,
      from: deps.from,
      to: p.email,
      ...(p.confirmationCopy ? { copy: p.confirmationCopy } : {}),
      purpose: participation ? 'participation' : 'subscription',
    });
  };
}

/** Sends the confirmation after commit, from the outbox, once per event (`sendOnce`). */
export function confirmationMailSubscriber(deps: ConfirmationMailDeps): Subscriber {
  const source = confirmationMailSource(deps);
  return {
    name: CONFIRMATION_SUBSCRIBER,
    types: ['newsletter.subscribed', PARTICIPATION_REQUESTED],
    async handle(event) {
      const message = await source(event);
      if (message) await sendOnce(deps, event, CONFIRMATION_SUBSCRIBER, message);
    },
  };
}
