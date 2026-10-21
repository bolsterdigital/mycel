// Double opt-in confirmation mail (ADR 010 rule 5). Copy comes from the domain catalogs in the
// recipient's locale (ADR 007 rule 5); markup is minimal table-free HTML plus a text part. The
// e-mail block renderer replaces `renderConfirmationMail` once templates are block documents.

import type { NewsletterSubscribedProps } from '../forms/events.js';
import { t } from '../i18n/index.js';
import type {
  Clock,
  DomainEvent,
  Signer,
  Subscriber,
  TransactionContext,
  UnitOfWork,
} from '../ports.js';
import { systemPrincipal } from '../principal.js';
import type { TenantDirectory } from '../tenants/ports.js';
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
}): MailMessage {
  const { locale, tenantName, confirmUrl } = input;
  const m = (key: Parameters<typeof t>[1]) => t(locale, key, { tenant: tenantName });
  const text = [m('mail.confirm.intro'), '', confirmUrl, '', m('mail.confirm.ignore')].join('\n');
  const url = escapeHtml(confirmUrl);
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head><meta charset="utf-8"><title>${escapeHtml(m('mail.confirm.heading'))}</title></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:36rem;padding:1.5rem">
    <h1 style="font-size:1.25rem">${escapeHtml(m('mail.confirm.heading'))}</h1>
    <p>${escapeHtml(m('mail.confirm.intro'))}</p>
    <p><a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:.75rem 1.25rem;border-radius:.5rem;text-decoration:none">${escapeHtml(m('mail.confirm.button'))}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.fallback'))}<br><a href="${url}" style="color:#52525b">${url}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.ignore'))}</p>
  </body>
</html>`;
  return {
    from: input.from,
    to: { email: input.to },
    subject: m('mail.confirm.subject'),
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
  /** Public origin of the web front; the link is `${publicBaseUrl}/${tenant.slug}/confirm`. */
  publicBaseUrl: string;
}

export const CONFIRMATION_SUBSCRIBER = 'mailing.confirmation';

/**
 * Send one transactional message exactly once per intent key (ADR 019 rule 6, ADR 011 rule 4).
 * Three transactions, deliberately not one: (1) the intent with `attemptedAt` commits before the
 * provider is called, (2) the provider call runs outside any transaction, (3) the outcome is
 * recorded. A crash between (2) and (3) leaves the intent attempted-but-unknown, and the next
 * delivery of the same event reconciles with the provider instead of sending again. `unknown`
 * from reconciliation throws, so the outbox backs off and nothing goes out blind.
 */
export async function sendOnce(
  deps: Pick<ConfirmationMailDeps, 'mailer' | 'clock' | 'uow'>,
  event: Pick<DomainEvent, 'id' | 'tenantId'>,
  subscriber: string,
  message: MailMessage
): Promise<'sent' | 'reconciled' | 'skipped'> {
  const key = `${subscriber}:${event.id}`;
  const principal = systemPrincipal(event.tenantId, subscriber);
  const run = <T>(fn: (ctx: TransactionContext) => Promise<T>) => deps.uow.run(principal, fn);

  const existing = await run((ctx) => ctx.mailSends.get(key));
  if (existing?.sentAt) return 'skipped';
  if (existing?.attemptedAt) {
    const verdict = await deps.mailer.wasSent(key, message, existing.attemptedAt);
    if (verdict === 'unknown')
      throw new Error(
        `mail ${key}: outcome of the attempt at ${existing.attemptedAt.toISOString()} is unknown; not resending`
      );
    if (verdict === 'sent') {
      await run((ctx) => ctx.mailSends.sent(key, deps.clock.now(), null));
      return 'reconciled';
    }
  }

  await run((ctx) =>
    ctx.mailSends.attempt({ key, subscriber, eventId: event.id }, deps.clock.now())
  );
  let providerId: string;
  try {
    ({ providerId } = await deps.mailer.send(message, key));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await run((ctx) => ctx.mailSends.failed(key, error));
    throw e;
  }
  await run((ctx) => ctx.mailSends.sent(key, deps.clock.now(), providerId));
  return 'sent';
}

/** Sends the confirmation after commit, from the outbox, once per event (see `sendOnce`). */
export function confirmationMailSubscriber(deps: ConfirmationMailDeps): Subscriber {
  return {
    name: CONFIRMATION_SUBSCRIBER,
    types: ['newsletter.subscribed'],
    async handle(event) {
      const p = event.props as unknown as NewsletterSubscribedProps;
      if (p.confirmed) return;
      const tenant = await deps.tenants.findById(event.tenantId);
      if (!tenant) throw new Error(`tenant ${event.tenantId} not found`);
      const token = await signConfirmToken(
        deps.signer,
        { tenantId: tenant.id, submissionId: p.submissionId, list: p.list },
        deps.clock.now()
      );
      const confirmUrl = `${deps.publicBaseUrl.replace(/\/$/, '')}/${tenant.slug}/confirm?token=${encodeURIComponent(token)}`;
      const message = renderConfirmationMail({
        locale: p.locale,
        tenantName: tenant.name,
        confirmUrl,
        from: deps.from,
        to: p.email,
      });
      await sendOnce(deps, event, CONFIRMATION_SUBSCRIBER, message);
    },
  };
}
