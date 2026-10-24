// The operator's browser session (brief #7 decision 7): a signed, stateless cookie value that
// says who logged in and until when, nothing about tenants or capabilities. Those are read from
// the memberships on every admin request, so revoking a membership takes effect at once and the
// cookie never needs to be invalidated for it. Twelve hours absolute, no sliding renewal: a
// stolen cookie stops working on a fixed clock.
//
// `typ` separates these tokens from the other payloads the same Signer signs (form timing, double
// opt-in), so no token issued for one purpose verifies as another. Rejected: a `sessions` table,
// which buys "log out everywhere" at the price of a write per login and a read per request;
// that becomes an item once someone needs it.

import { z } from 'zod';
import type { Clock, Signer } from '../ports.js';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SessionPayload = z.object({
  v: z.literal(1),
  typ: z.literal('session'),
  /** Random per login, so two sessions of one operator never share a cookie value. */
  sid: z.string().min(16),
  op: z.string().guid(),
  email: z.string().email(),
  name: z.string().nullable(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export interface OperatorSession {
  operatorId: string;
  email: string;
  name: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh session for this operator: always a new value, never an extension of an old one. */
export async function issueSession(
  signer: Signer,
  clock: Clock,
  operator: { id: string; email: string; name: string | null }
): Promise<{ token: string; session: OperatorSession }> {
  const iat = clock.now().getTime();
  const exp = iat + SESSION_TTL_MS;
  const token = await signer.sign(
    JSON.stringify({
      v: 1,
      typ: 'session',
      sid: randomId(),
      op: operator.id,
      email: operator.email,
      name: operator.name,
      iat,
      exp,
    })
  );
  return {
    token,
    session: {
      operatorId: operator.id,
      email: operator.email,
      name: operator.name,
      issuedAt: new Date(iat),
      expiresAt: new Date(exp),
    },
  };
}

/** The session in a cookie value, or null when it is forged, malformed or expired. */
export async function readSession(
  signer: Signer,
  clock: Clock,
  token: string | undefined
): Promise<OperatorSession | null> {
  if (!token) return null;
  const raw = await signer.verify(token);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SessionPayload.safeParse(json);
  if (!parsed.success) return null;
  const p = parsed.data;
  const now = clock.now().getTime();
  if (now >= p.exp || p.exp - p.iat > SESSION_TTL_MS || p.iat > now + 60_000) return null;
  return {
    operatorId: p.op,
    email: p.email,
    name: p.name,
    issuedAt: new Date(p.iat),
    expiresAt: new Date(p.exp),
  };
}
