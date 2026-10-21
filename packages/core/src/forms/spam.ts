// Spam defence that is not optional (ADR 010 rule 5): honeypot, minimum fill time and rate
// limits. ALTCHA proof-of-work is a follow-up (brief: out of scope for the probe). The timing
// token is signed so a bot cannot simply post an old timestamp.

import type { Signer } from '../ports.js';

export const RATE_LIMITS = {
  perIp: { max: 10, windowSeconds: 10 * 60 },
  perEmail: { max: 3, windowSeconds: 60 * 60 },
} as const;

/** A token older than this is stale; the visitor gets a fresh one with the re-rendered form. */
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

export async function issueStartedToken(
  signer: Signer,
  formId: string,
  now: Date
): Promise<string> {
  return signer.sign(JSON.stringify({ f: formId, t: now.getTime() }));
}

export type TimingVerdict = 'ok' | 'too-fast' | 'invalid';

export async function checkStartedToken(
  signer: Signer,
  token: string | undefined,
  formId: string,
  minFillSeconds: number,
  now: Date
): Promise<TimingVerdict> {
  if (!token) return 'invalid';
  const payload = await signer.verify(token);
  if (!payload) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'invalid';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'invalid';
  const { f, t } = parsed as { f?: unknown; t?: unknown };
  if (f !== formId || typeof t !== 'number') return 'invalid';
  const age = now.getTime() - t;
  if (age < 0 || age > MAX_TOKEN_AGE_MS) return 'invalid';
  return age < minFillSeconds * 1000 ? 'too-fast' : 'ok';
}
