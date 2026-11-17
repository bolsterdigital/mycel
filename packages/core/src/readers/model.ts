// Reader sign-in (ADR 016 rule 1, ADR 019): a reader is a supporter who proved their address with
// a magic link and holds a session on one tenant hostname. Two signed values, both opaque ids and
// times only, never an address or a capability:
//
// - the link token `{ typ: 'reader-signin', tid, lid, exp }`. Signing is deterministic, so the
//   mail source rebuilds the same link from the link row and no raw token ever sits in the
//   outbox, a job or a log. The row keeps a hash of the token and `consume` compares it, so a
//   token signed under another secret or for another row never matches.
// - the session cookie `{ typ: 'reader-session', tid, sid, iat, exp }`. It names a session row;
//   the supporter is read from that row and its live projection on every request, so sign-out,
//   erasure and a revoked session work before the cookie expires (ADR 019 rule 5).
//
// `typ` keeps these apart from every other payload the same Signer signs (operator session, form
// timing, double opt-in). Rejected: a stateless session like the operator's (no way to end one
// reader's session before its clock runs out, which erasure needs), the supporter id in the
// cookie (the row already says it, and a cookie is not where an identity is decided), and a
// random token stored as a hash only (the mail could then not be rebuilt for a reconcile without
// keeping the raw token somewhere).

import { z } from 'zod';
import type { Signer } from '../ports.js';
import { sha256Hex } from '../util/digest.js';

/** A link is good for this long after the request, once. */
export const SIGNIN_LINK_TTL_MS = 15 * 60 * 1000;
/** A session ends this long after sign-in, absolutely: no sliding renewal. */
export const READER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** One sign-in mail per address per tenant within this many seconds (sliding). */
export const SIGNIN_MAIL_COOLDOWN_SECONDS = 24 * 60 * 60;
/** The scope the timing token and the proof of the sign-in form are issued for. */
export const SIGNIN_FORM_SCOPE = 'reader.signin';
/** Shorter than this between rendering the form and posting it is not a person. */
export const SIGNIN_MIN_FILL_SECONDS = 2;
export const SIGNIN_RATE_LIMITS = {
  perIp: { max: 10, windowSeconds: 10 * 60 },
  perIpUnproven: { max: 3, windowSeconds: 60 * 60 },
} as const;

export const SIGNIN_REQUESTED = 'reader.signin.requested';

/** What the outbox carries for a requested link: the row's id and nothing of the person. */
export interface SigninRequestedProps {
  linkId: string;
}

export interface SigninLink {
  id: string;
  /** Normalised; the one copy of the address this flow keeps, deleted with the row. */
  email: string;
  tokenHash: string;
  locale: string;
  /** Site-relative path to go to after sign-in, or null for the reader page. */
  returnPath: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ReaderSession {
  id: string;
  supporterId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

const LinkPayload = z.object({
  typ: z.literal('reader-signin'),
  tid: z.string().guid(),
  lid: z.string().guid(),
  exp: z.number().int(),
});

const SessionPayload = z.object({
  typ: z.literal('reader-session'),
  tid: z.string().guid(),
  sid: z.string().guid(),
  iat: z.number().int(),
  exp: z.number().int(),
});

async function payloadOf(signer: Signer, token: string | undefined): Promise<unknown> {
  if (!token) return null;
  const raw = await signer.verify(token);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The link token of a row: the same value every time for the same tenant, row and expiry. */
export function signinToken(
  signer: Signer,
  tenantId: string,
  link: Pick<SigninLink, 'id' | 'expiresAt'>
): Promise<string> {
  return signer.sign(
    JSON.stringify({
      typ: 'reader-signin',
      tid: tenantId,
      lid: link.id,
      exp: link.expiresAt.getTime(),
    })
  );
}

export const signinTokenHash = (token: string): Promise<string> => sha256Hex(token);

/** The link a token names on this tenant, or null: forged, another tenant's, or past its time. */
export async function readSigninToken(
  signer: Signer,
  token: string | undefined,
  tenantId: string,
  now: Date
): Promise<{ linkId: string } | null> {
  const parsed = LinkPayload.safeParse(await payloadOf(signer, token));
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.tid !== tenantId || now.getTime() >= p.exp) return null;
  return { linkId: p.lid };
}

export function sessionToken(
  signer: Signer,
  tenantId: string,
  session: Pick<ReaderSession, 'id' | 'createdAt' | 'expiresAt'>
): Promise<string> {
  return signer.sign(
    JSON.stringify({
      typ: 'reader-session',
      tid: tenantId,
      sid: session.id,
      iat: session.createdAt.getTime(),
      exp: session.expiresAt.getTime(),
    })
  );
}

/**
 * The session id a cookie value names on this tenant, or null. Signature, kind, tenant and time
 * only; whether the session still stands is the row's and the projection's to say.
 */
export async function readSessionToken(
  signer: Signer,
  token: string | undefined,
  tenantId: string,
  now: Date
): Promise<{ sessionId: string } | null> {
  const parsed = SessionPayload.safeParse(await payloadOf(signer, token));
  if (!parsed.success) return null;
  const p = parsed.data;
  const at = now.getTime();
  if (p.tid !== tenantId || at >= p.exp || p.exp - p.iat > READER_SESSION_TTL_MS) return null;
  if (p.iat > at + 60_000) return null;
  return { sessionId: p.sid };
}

/**
 * A path on this site to return to after sign-in, or null. One leading slash, no scheme, no
 * second slash or backslash a browser would read as another host, no control characters: the
 * value comes from a query string, and a sign-in must never send someone elsewhere.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}
