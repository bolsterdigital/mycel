// Reader sign-in use cases (ADR 016 rule 1, ADR 019 rules 1, 5 and 7). The tenant is always the
// principal's, which the web front takes from the hostname; no input names a tenant or a
// supporter.
//
// `reader.signin.request` answers the same for every address and every refusal: a known address,
// an unknown one, a bot, a limited client and an erased address all get `accepted`, so the route
// tells nobody who reads this site. It writes a link row and one outbox event that carries the
// row's id; the mail is built from the row after commit (mail.ts). It makes no supporter.
// `reader.signin.complete` uses the link once and, in the same transaction, resolves or creates
// the supporter, appends `reader.signed_in` and opens the session; only then does a cookie exist.
//
// Rejected: completing on the GET of the link (a mail scanner would sign in and burn the link;
// the page posts, like the double opt-in), an error for a limited or unknown address (it names
// who is a reader), and writing the supporter at request time (an address someone else typed
// would become a supporter without ever proving anything).

import { z } from 'zod';
import { withinLimit } from '../entitlements/guards.js';
import { Locale } from '../i18n/locale.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { emailKey } from '../supporters/email-key.js';
import { isTombstone } from '../supporters/erasure.js';
import { SupporterEvent } from '../supporters/events.js';
import { SOURCE, appendAndFold } from '../supporters/service.js';
import '../supporters/ports.js';
import { sha1Hex } from '../util/digest.js';
import { EmailAddress } from '../util/email.js';
import {
  READER_SESSION_TTL_MS,
  SIGNIN_FORM_SCOPE,
  SIGNIN_LINK_TTL_MS,
  SIGNIN_MAIL_COOLDOWN_SECONDS,
  SIGNIN_MIN_FILL_SECONDS,
  SIGNIN_RATE_LIMITS,
  SIGNIN_REQUESTED,
  readSessionToken,
  readSigninToken,
  safeReturnPath,
  sessionToken,
  signinToken,
  signinTokenHash,
  type ReaderSession,
  type SigninRequestedProps,
} from './model.js';
import { refuseLinkRequest } from './link-request.js';
import './ports.js';

const SigninRequestInput = z.object({
  email: EmailAddress,
  /** The language of the mail: the locale of the page the form was on. */
  locale: Locale,
  /** A path on this site to go back to after sign-in; anything else is dropped. */
  returnPath: z.string().max(500).optional(),
  /** As on `form.submit`: the public form posts all three, a post without the honeypot is a bot. */
  spam: z
    .object({
      honeypot: z.string().optional(),
      startedToken: z.string().optional(),
      proof: z.string().max(4000).optional(),
    })
    .optional(),
});

const SigninRequestResult = z.object({ status: z.literal('accepted') });

export const requestSignin = defineUseCase({
  name: 'reader.signin.request',
  kind: 'command',
  description:
    'Ask for a sign-in link for an e-mail address on this site. Always answers accepted: at most one mail per address per day goes out, and the answer never says whether the address is known, limited or refused.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  input: SigninRequestInput,
  output: SigninRequestResult,
  examples: [
    {
      input: { email: 'reader@example.org', locale: 'nl' },
      note: 'The public form also sends `spam.honeypot` (empty) and `spam.startedToken`; without them nothing is mailed and the answer is the same.',
    },
  ],
  async handler(ctx, input) {
    const accepted = { status: 'accepted' } as const;
    // One line per refusal with a fixed reason, never the address, the IP hash or a token.
    const refuse = (reason: string) => {
      ctx.log.info('reader.signin.refused', { reason });
      return accepted;
    };

    const refusal = await refuseLinkRequest(ctx, input.spam, {
      scope: SIGNIN_FORM_SCOPE,
      minFillSeconds: SIGNIN_MIN_FILL_SECONDS,
      limits: SIGNIN_RATE_LIMITS,
    });
    if (refusal) return refuse(refusal);

    const refused = await mailSigninLink(ctx, input.email, input.locale, input.returnPath);
    return refused ? refuse(refused) : accepted;
  },
});

/**
 * Mail a sign-in link for `email`, after the refusals that depend on the address: an erasure, and
 * one mail per address per day. Returns the reason it refused, or null when the link is on its
 * way. The caller has passed the spam defence of its own form (or holds a capability, as the
 * return page of a membership does, `donation.signin.request`).
 */
export async function mailSigninLink(
  ctx: TransactionContext,
  email: string,
  locale: string,
  returnPath: string | undefined
): Promise<'erased' | 'recipient-limited' | null> {
  const { principal, clock } = ctx;
  const now = clock.now();
  // An erased address gets no link: coming back after an erasure is an explicit signup through
  // a form (ADR 032), not a sign-in. A readmitted supporter is their current id.
  await ctx.supporters.lock(email);
  const holder = await ctx.supporters.getProjection(email);
  if (!(await ctx.erasures.allows(email, holder?.id))) return 'erased';

  // One mail per address per day, after everything that may refuse: a refused attempt never
  // closes the address for the person who owns it. The bucket holds a hash, not the address.
  const recipient = await emailKey(principal.tenantId, email, 'rate-limit');
  if (!(await ctx.rateLimits.cooldown(`reader.signin:${recipient}`, SIGNIN_MAIL_COOLDOWN_SECONDS)))
    return 'recipient-limited';

  const link = {
    id: ctx.ids.next(),
    email,
    locale,
    returnPath: safeReturnPath(returnPath),
    createdAt: now,
    expiresAt: new Date(now.getTime() + SIGNIN_LINK_TTL_MS),
    consumedAt: null,
  };
  const token = await signinToken(ctx.signer, principal.tenantId, link);
  await ctx.signinLinks.insert({ ...link, tokenHash: await signinTokenHash(token) });
  const props: SigninRequestedProps = { linkId: link.id };
  await ctx.events.publish({
    // The event of a link carries the link's id: its mail intent and reconcile job are then
    // found from the row alone, which is how an erasure removes them with it.
    id: link.id,
    type: SIGNIN_REQUESTED,
    tenantId: principal.tenantId,
    occurredAt: now,
    // The stored actor of a visitor, without the client hash: the event names a link, no one.
    actor: { kind: 'anonymous', channel: 'web' },
    props: { ...props },
  });
  return null;
}

const SigninCompleteResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('signed_in'),
    /** The value of the reader cookie; the front sets it and never shows it. */
    sessionToken: z.string(),
    expiresAt: z.string().datetime({ offset: true }),
    returnPath: z.string().nullable(),
    locale: z.string(),
  }),
  /** Forged, expired, used, for another site or for an erased address: one answer for all. */
  z.object({ status: z.literal('invalid') }),
]);
export type SigninCompleteResult = z.infer<typeof SigninCompleteResult>;

/**
 * The supporter who proved `email`, with `reader.signed_in` appended: the live holder of the
 * address, or a new supporter when nobody holds it. Null when the address may not be used (an
 * erasure stands). Under the address lock, in the order ingest takes its locks.
 */
async function signedInSupporter(
  ctx: TransactionContext,
  email: string,
  linkId: string,
  now: Date
): Promise<string | null> {
  await ctx.supporters.lock(email);
  const holder = await ctx.supporters.getProjection(email);
  const live = holder && !isTombstone(holder.email) ? holder : null;
  if (!(await ctx.erasures.allows(email, live?.id))) return null;
  let supporterId = live?.id;
  if (!supporterId) {
    // A first sign-in makes a supporter, so it counts against the cap like a first signup
    // (ADR 015 rule 3); a seat a pending signup already holds for the address is that same seat.
    await ctx.admissions.lock();
    if (!(await ctx.admissions.pending(email)))
      withinLimit(ctx, 'supporters.max', await ctx.admissions.count());
    supporterId = (await ctx.supporters.resolve(email)).id;
  }
  const occurredAt = now.toISOString();
  const sourceRef = `reader-signin:${linkId}`;
  const type = 'reader.signed_in';
  await appendAndFold(ctx, {
    ...SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: await sha1Hex([SOURCE, sourceRef, type, occurredAt].join('|')),
      type,
      email,
      occurred_at: occurredAt,
      source: SOURCE,
      source_site: 'urn:mycel:reader',
      source_ref: sourceRef,
      props: {},
    }),
    supporter_id: supporterId,
  });
  if (!live) await ctx.admissions.release(email);
  return supporterId;
}

export const completeSignin = defineUseCase({
  name: 'reader.signin.complete',
  kind: 'command',
  description:
    'Use a sign-in link once: records reader.signed_in for the supporter of the address (a first sign-in makes the supporter) and opens a reader session on this site. An invalid, expired or used link is an outcome, not an error.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  input: z.object({ token: z.string().min(1).max(4000) }),
  output: SigninCompleteResult,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'A forged, expired or used token gives status "invalid"; nothing is written.',
    },
  ],
  async handler(ctx, { token }): Promise<SigninCompleteResult> {
    const { principal, clock } = ctx;
    const now = clock.now();
    const invalid = { status: 'invalid' } as const;
    const named = await readSigninToken(ctx.signer, token, principal.tenantId, now);
    if (!named) return invalid;
    // The one statement that decides between two clicks on the same link.
    const link = await ctx.signinLinks.consume(named.linkId, await signinTokenHash(token), now);
    if (!link) return invalid;
    const supporterId = await signedInSupporter(ctx, link.email, link.id, now);
    // The link stays consumed: an address that may not sign in gets no second try on this link.
    if (!supporterId) return invalid;
    const session: ReaderSession = {
      id: ctx.ids.next(),
      supporterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + READER_SESSION_TTL_MS),
      revokedAt: null,
    };
    await ctx.readerSessions.insert(session);
    return {
      status: 'signed_in',
      sessionToken: await sessionToken(ctx.signer, principal.tenantId, session),
      expiresAt: session.expiresAt.toISOString(),
      returnPath: link.returnPath,
      locale: link.locale,
    };
  },
});

/**
 * The standing session a cookie value names on this tenant, with its supporter read from the
 * session row and the live projection now: a revoked or expired session, an erased supporter and
 * a cookie of another site are all nobody.
 */
export async function standingSession(
  ctx: TransactionContext,
  token: string | undefined
): Promise<ReaderSession | null> {
  const now = ctx.clock.now();
  const named = await readSessionToken(ctx.signer, token, ctx.principal.tenantId, now);
  if (!named) return null;
  return liveSession(ctx, named.sessionId, now);
}

/** The session by id when it stands and its supporter is live. */
export async function liveSession(
  ctx: TransactionContext,
  sessionId: string,
  now: Date
): Promise<ReaderSession | null> {
  const session = await ctx.readerSessions.getLive(sessionId, now);
  if (!session) return null;
  const supporter = await ctx.supporters.getProjectionById(session.supporterId);
  if (!supporter || isTombstone(supporter.email)) return null;
  // A registered erasure ends the session at once, before the worker has applied it.
  if (await ctx.erasures.get(session.supporterId)) return null;
  return session;
}

const ReaderSessionView = z.object({
  /** What the front builds the reader principal from; null when nobody is signed in. */
  session: z
    .object({ sessionId: z.string().guid(), expiresAt: z.string().datetime({ offset: true }) })
    .nullable(),
});
export type ReaderSessionView = z.infer<typeof ReaderSessionView>;

export const getReaderSession = defineUseCase({
  name: 'reader.session.get',
  kind: 'query',
  description:
    'Read whether a reader cookie value names a standing session on this site: signed, of this tenant, not expired, not signed out, and of a supporter who is not erased. Returns the session id and its end, never the supporter or an address.',
  requires: 'content:read',
  actors: ['anonymous', 'reader'],
  input: z.object({ token: z.string().min(1).max(4000) }),
  output: ReaderSessionView,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'Anything that is not a standing session of this site gives `session: null`.',
    },
  ],
  async handler(ctx, { token }): Promise<ReaderSessionView> {
    const session = await standingSession(ctx, token);
    return {
      session: session
        ? { sessionId: session.id, expiresAt: session.expiresAt.toISOString() }
        : null,
    };
  },
});

export const signoutReader = defineUseCase({
  name: 'reader.signout',
  kind: 'command',
  description:
    'End the session of the signed-in reader on this site. The cookie that named it stops working at once, also when a copy of it is kept elsewhere.',
  requires: 'content:read',
  actors: ['reader'],
  input: z.object({}),
  output: z.object({ status: z.literal('signed_out') }),
  examples: [{ input: {}, note: 'Runs as the reader; a session that already ended is fine.' }],
  async handler(ctx) {
    const { actor } = ctx.principal;
    if (actor.kind === 'reader') await ctx.readerSessions.revoke(actor.sessionId, ctx.clock.now());
    return { status: 'signed_out' } as const;
  },
});
