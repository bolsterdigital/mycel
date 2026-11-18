// The donor's own page for their monthly or yearly gift (ADR 005 rule 6, brief MY-254 PR 3). A
// signed link names a supporter of one site for seven days; whoever holds it sees that
// supporter's gifts and may change the amount, pause, resume or stop them, without an account.
// It is a capability link: the token is the permission, so it holds opaque ids and times only,
// never an address or an amount, and a forged, expired or another site's token is nobody.
//
// The token `{ typ: 'donation-self', tid, sup, exp }` is stateless: signing is deterministic, so
// a mail source rebuilds the same link from the event it sends for (the expiry is the event's
// time plus the lifetime) and no token sits in the outbox, a job or a log. It is good many times
// within its week: the donor may come back to the same mail. An erasure ends it at once, because
// the supporter it names is read live on every use.
//
// Rejected: a link row per mail like the reader's sign-in (a one-use, fifteen-minute link fits a
// sign-in, not a page the donor returns to from a mail of last week, and a row per notice is a
// copy for the erasure to find), and the subscription id in the token (one mail would reach one
// gift, and a donor with two would need two links).

import { z } from 'zod';
import type { Signer, TransactionContext } from '../ports.js';
import { storedActor } from '../principal.js';
import { Interval, type Subscription } from './subscription-model.js';

/** A link is good for this long after the mail it came in. */
export const SELF_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One link mail per address per tenant within this many seconds (sliding). */
export const SELF_MAIL_COOLDOWN_SECONDS = 24 * 60 * 60;
/** The scope the timing token and the proof of the request form are issued for. */
export const SELF_FORM_SCOPE = 'donation.self';
export const SELF_MIN_FILL_SECONDS = 2;
export const SELF_RATE_LIMITS = {
  perIp: { max: 10, windowSeconds: 10 * 60 },
  perIpUnproven: { max: 3, windowSeconds: 60 * 60 },
} as const;

/** The donor's page on the site: the request form, or with a token in the path their gifts. */
export const SELF_PATH = '/my-giving';

/** An asked-for link: the outbox event names the supporter and the locale, nothing else. */
export const SELF_LINK_REQUESTED = 'donation.self.requested';
export interface SelfLinkRequestedProps {
  supporterId: string;
  locale: string;
}

/** What the giver hears about their gift, by mail (brief MY-254 PR 3). */
export const GivingNoticeKind = z.enum(['started', 'charge-failed', 'ended', 'cancelled']);
export type GivingNoticeKind = z.infer<typeof GivingNoticeKind>;

/**
 * A notice in the outbox. The facts the mail states travel in the props, so the reconcile job
 * rebuilds exactly what was sent; only the address is read when the mail is built, and an
 * erasure stops it there.
 */
export const GIVING_NOTICE = 'donation.subscription.notice';
export const GivingNoticeProps = z.object({
  subscriptionId: z.string().guid(),
  notice: GivingNoticeKind,
  amount: z.number().int(),
  currency: z.string(),
  interval: Interval,
  locale: z.string(),
  /** For `charge-failed`: when the next attempt is due, if one is. */
  nextChargeAt: z.string().nullable(),
});
export type GivingNoticeProps = z.infer<typeof GivingNoticeProps>;

/**
 * Put a notice for the giver of `sub` in the outbox; it is mailed after commit (giving-mail.ts).
 * A gift without a supporter (erased) gets none. A membership's notices come with memberships
 * (PR 4), whose words are another's.
 */
export async function noticeGiver(
  ctx: TransactionContext,
  sub: Subscription,
  notice: GivingNoticeKind
): Promise<void> {
  if (!sub.supporterId || sub.kind !== 'donation') return;
  const props: GivingNoticeProps = {
    subscriptionId: sub.id,
    notice,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
    locale: sub.locale,
    nextChargeAt: notice === 'charge-failed' ? sub.nextChargeAt : null,
  };
  await ctx.events.publish({
    id: ctx.ids.next(),
    type: GIVING_NOTICE,
    tenantId: ctx.principal.tenantId,
    occurredAt: ctx.clock.now(),
    actor: storedActor(ctx.principal.actor),
    props: { ...props },
  });
}

const Payload = z.object({
  typ: z.literal('donation-self'),
  tid: z.string().guid(),
  sup: z.string().guid(),
  exp: z.number().int(),
});

/** The link token for a supporter of a tenant: the same value every time for the same expiry. */
export function selfToken(
  signer: Signer,
  tenantId: string,
  supporterId: string,
  expiresAt: Date
): Promise<string> {
  return signer.sign(
    JSON.stringify({
      typ: 'donation-self',
      tid: tenantId,
      sup: supporterId,
      exp: expiresAt.getTime(),
    })
  );
}

/** The supporter a token names on this tenant, or null: forged, another site's, or too old. */
export async function readSelfToken(
  signer: Signer,
  token: string | undefined,
  tenantId: string,
  now: Date
): Promise<{ supporterId: string } | null> {
  if (!token) return null;
  const raw = await signer.verify(token);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = Payload.safeParse(value);
  if (!parsed.success) return null;
  const p = parsed.data;
  // A token valid for longer than a link ever is was not made here.
  if (p.tid !== tenantId || now.getTime() >= p.exp) return null;
  if (p.exp - now.getTime() > SELF_LINK_TTL_MS + 60_000) return null;
  return { supporterId: p.sup };
}
