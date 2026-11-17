// The sign-in mail (ADR 016 rule 1, ADR 019 rule 6). The outbox event names a link row and
// nothing else; this source reads the row, signs its token again (signing is deterministic, so it
// is the same link) and builds the message. So no raw token and no address sits in the outbox, a
// job payload or a log, and the `mail.reconcile` job rebuilds exactly what the subscriber sent.
//
// The source dries up on its own: a consumed or expired link, a row an erasure deleted and a
// suspended site all give no message, so a retry after the link's time sends nothing. An attempt
// whose outcome is unknown when the link expires stays visible as unresolved and is never resent
// (docs/reference/mail.md). Transactional stream, no list headers: the person asked for it, and
// signing in grants no list (ADR 010 rule 5).
// Rejected: the address or the token in the event props (two more copies for an erasure to find)
// and a second send path beside `sendOnce` (the intent row is what makes a timeout safe).

import { t } from '../i18n/index.js';
import type { Subscriber } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { siteUrl } from '../tenants/url.js';
import type { ConfirmationMailDeps } from '../mailing/confirmation.js';
import type { MailAddress, MailMessage } from '../mailing/ports.js';
import { sendOnce, type MailSource } from '../mailing/send-attempts.js';
import { SIGNIN_REQUESTED, signinToken, type SigninRequestedProps } from './model.js';
import './ports.js';

export const SIGNIN_MAIL_SUBSCRIBER = 'reader.signin.mail';

/** Where the link lands: a page with one button, whose post signs in (routes/(public)/reader). */
export const SIGNIN_PATH = '/reader/signin';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSigninMail(input: {
  locale: string;
  tenantName: string;
  signinUrl: string;
  from: MailAddress;
  to: string;
}): MailMessage {
  const { locale, signinUrl } = input;
  const m = (key: Parameters<typeof t>[1]) => t(locale, key, { tenant: input.tenantName });
  const heading = m('mail.signin.heading');
  const text = [
    m('mail.signin.intro'),
    '',
    signinUrl,
    '',
    m('mail.signin.expires'),
    m('mail.signin.ignore'),
  ].join('\n');
  const url = escapeHtml(signinUrl);
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
  <head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b;max-width:36rem;padding:1.5rem">
    <h1 style="font-size:1.25rem">${escapeHtml(heading)}</h1>
    <p>${escapeHtml(m('mail.signin.intro'))}</p>
    <p><a href="${url}" style="display:inline-block;background:#18181b;color:#fff;padding:.75rem 1.25rem;border-radius:.5rem;text-decoration:none">${escapeHtml(m('mail.signin.button'))}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.confirm.fallback'))}<br><a href="${url}" style="color:#52525b">${url}</a></p>
    <p style="font-size:.875rem;color:#52525b">${escapeHtml(m('mail.signin.expires'))} ${escapeHtml(m('mail.signin.ignore'))}</p>
  </body>
</html>`;
  return {
    from: input.from,
    to: { email: input.to },
    subject: m('mail.signin.subject'),
    text,
    html,
    stream: 'transactional',
  };
}

/** The message for a `reader.signin.requested` event, or null once its link is of no use. */
export function signinMailSource(deps: ConfirmationMailDeps): MailSource {
  return async (event) => {
    const { linkId } = event.props as unknown as SigninRequestedProps;
    if (typeof linkId !== 'string') return null;
    if (deps.access && (await deps.access(event.tenantId)).status === 'suspended') return null;
    const system = systemPrincipal(event.tenantId, SIGNIN_MAIL_SUBSCRIBER);
    // The link and the primary hostname are the tenant's rows, read under its RLS.
    const { link, primary } = await deps.uow.run(system, async (ctx) => ({
      link: await ctx.signinLinks.get(linkId),
      primary: await ctx.hostnames.primary(),
    }));
    if (!link || link.consumedAt || link.expiresAt.getTime() <= deps.clock.now().getTime())
      return null;
    const tenant = await deps.tenants.findById(event.tenantId);
    if (!tenant) throw new Error(`tenant ${event.tenantId} not found`);
    const token = await signinToken(deps.signer, tenant.id, link);
    // Always the primary hostname (ADR 014 rule 6): the host the request came in on plays no part.
    const signinUrl = siteUrl(
      { slug: tenant.slug, primaryHostname: primary?.hostname ?? null },
      deps.platform,
      `${SIGNIN_PATH}?token=${encodeURIComponent(token)}`
    );
    return renderSigninMail({
      locale: link.locale,
      tenantName: tenant.name,
      signinUrl,
      from: deps.from,
      to: link.email,
    });
  };
}

/** Sends the link after commit, from the outbox, once per event (`sendOnce`). */
export function signinMailSubscriber(deps: ConfirmationMailDeps): Subscriber {
  const source = signinMailSource(deps);
  return {
    name: SIGNIN_MAIL_SUBSCRIBER,
    types: [SIGNIN_REQUESTED],
    async handle(event) {
      const message = await source(event);
      if (message) await sendOnce(deps, event, SIGNIN_MAIL_SUBSCRIBER, message);
    },
  };
}
