// Proof-of-work for public forms (ADR 010 rule 5, brief form-intake § D2): the ALTCHA v1
// protocol with SHA-256, in our own forty lines. The server picks a salt and a secret number in
// [0, maxNumber]; the challenge is sha256hex(salt + number) and the browser finds the number by
// counting up. The signature is the existing `Signer` (the HMAC of `startedToken`) over the form,
// the challenge and the expiry, so a solution only counts for the form it was issued for, and
// only for as long as a timing token lives. Reuse is refused by the handler, with a cooldown on
// the challenge. Pure apart from Web Crypto, which core may use (util/digest.ts).
// Rejected: `altcha-lib` (MIT, but a licence check for forty lines) and the `altcha` widget (a
// visible checkbox with its own i18n and accessibility surface; ADR 008 rule 1).

import { z } from 'zod';
import type { Signer } from '../ports.js';
import { sha256Hex } from '../util/digest.js';
import { randomHex } from '../util/token.js';

/**
 * The search space; on average half of it is searched. Measured 2026-10-23 in headless Chromium
 * with the script's batching (apps/web/static/_form/proof.js): 0.4 s on average on an M4 Pro,
 * 0.6 s with the CPU throttled four times (about a mid-range phone), 1.5 s for the whole space
 * at that throttle. The script waits at most two seconds before it posts without.
 */
export const PROOF_MAX_NUMBER = 100_000;

/** As long as a timing token: a page left open for a day still posts. */
const PROOF_TTL_MS = 24 * 60 * 60 * 1000;

export const ProofChallenge = z.object({
  algorithm: z.literal('SHA-256'),
  challenge: z.string(),
  salt: z.string(),
  maxNumber: z.number().int().min(1),
  signature: z.string(),
});
export type ProofChallenge = z.infer<typeof ProofChallenge>;

/** What the browser posts as `_proof`: base64 of this JSON, as ALTCHA does. */
const ProofSolution = z.object({
  algorithm: z.literal('SHA-256'),
  challenge: z.string().regex(/^[0-9a-f]{64}$/),
  number: z.number().int().nonnegative(),
  salt: z.string().max(200),
  signature: z.string().max(2000),
});

/** A uniformly random integer in [0, max]. */
function randomInt(max: number): number {
  const [n] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return n! % (max + 1);
}

export async function issueProofChallenge(
  signer: Signer,
  formId: string,
  now: Date,
  maxNumber = PROOF_MAX_NUMBER
): Promise<ProofChallenge> {
  const salt = randomHex(12);
  const challenge = await sha256Hex(`${salt}${randomInt(maxNumber)}`);
  const signature = await signer.sign(
    JSON.stringify({ f: formId, c: challenge, e: now.getTime() + PROOF_TTL_MS })
  );
  return { algorithm: 'SHA-256', challenge, salt, maxNumber, signature };
}

/**
 * `absent`: nothing posted (no JavaScript, or a client that gave up); the handler takes the
 * stricter `unproven` route. `invalid`: posted but malformed, wrongly signed, expired, issued for
 * another form or not a solution. `ok` carries the challenge, for the reuse cooldown.
 */
export type ProofVerdict =
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'ok'; challenge: string };

export async function checkProof(
  signer: Signer,
  proof: string | undefined,
  formId: string,
  now: Date
): Promise<ProofVerdict> {
  if (!proof) return { kind: 'absent' };
  let solution: z.infer<typeof ProofSolution>;
  try {
    const parsed = ProofSolution.safeParse(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(proof), (c) => c.charCodeAt(0))))
    );
    if (!parsed.success) return { kind: 'invalid' };
    solution = parsed.data;
  } catch {
    return { kind: 'invalid' };
  }
  const payload = await signer.verify(solution.signature);
  if (!payload) return { kind: 'invalid' };
  let signed: unknown;
  try {
    signed = JSON.parse(payload);
  } catch {
    return { kind: 'invalid' };
  }
  const { f, c, e } = (signed ?? {}) as { f?: unknown; c?: unknown; e?: unknown };
  if (f !== formId || c !== solution.challenge || typeof e !== 'number' || now.getTime() > e)
    return { kind: 'invalid' };
  if ((await sha256Hex(`${solution.salt}${solution.number}`)) !== solution.challenge)
    return { kind: 'invalid' };
  return { kind: 'ok', challenge: solution.challenge };
}
