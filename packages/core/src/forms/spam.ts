// Spam defence that is not optional (ADR 010 rule 5): honeypot, minimum fill time, rate limits
// and ALTCHA proof-of-work (proof.ts). The timing token is signed so a bot cannot simply post an
// old timestamp.
//
// Two limits with two faces. Per IP a visible 429: a person behind a shared address deserves a
// real message. Per recipient a silent cooldown (`CONFIRMATION_COOLDOWN_SECONDS`, house rule 1
// of `formulieren-en-mail`): at most one confirmation mail per address per form per day, and
// above it the same thank-you page, so neither a bot nor a third party learns that the address
// was just used. Rejected: the earlier per-address counter of three an hour (72 mails a day,
// and its refusal told the bot it had hit a real address).

import type { Signer } from '../ports.js';

// A post without a proof (no JavaScript, or a client that gave up) is not refused, ADR 009 wins:
// it takes the stricter `perIpUnproven` bucket on top of `perIp` (brief form-intake § D2.2,
// decisions.md 2026-10-23). The recipient cooldown protects a victim on either route.
export const RATE_LIMITS = {
  perIp: { max: 10, windowSeconds: 10 * 60 },
  perIpUnproven: { max: 3, windowSeconds: 60 * 60 },
} as const;

/** One confirmation mail per address per form within this many seconds (sliding). */
export const CONFIRMATION_COOLDOWN_SECONDS = 24 * 60 * 60;

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
