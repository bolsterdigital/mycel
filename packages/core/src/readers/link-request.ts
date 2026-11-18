// The defence of a public form that mails a link to an address (`formulieren-en-mail`): the
// reader's sign-in link (ADR 016 rule 1) and the donor's self-service link (ADR 005 rule 6) ask
// the same questions in the same order, so they share them here. Every refusal is a fixed reason
// for one log line; the caller answers the same for all of them, so the form tells nobody who is
// known.
//
// Order: honeypot, signed minimum fill time, proof of work (a solved challenge counts once), the
// client's buckets (a post without a proof takes the stricter one). The per-address cooldown is
// not here: it comes after everything that may refuse for the address itself, so a refused
// attempt never closes the address for its owner.
// Rejected: a copy per flow (two places to keep in step for one checklist).

import { checkProof } from '../forms/proof.js';
import { checkStartedToken } from '../forms/spam.js';
import '../forms/ports.js';
import type { TransactionContext } from '../ports.js';

export interface LinkRequestSpam {
  honeypot?: string | undefined;
  startedToken?: string | undefined;
  proof?: string | undefined;
}

export interface LinkRequestPolicy {
  /** The scope the timing token and the proof were issued for, and the prefix of the buckets. */
  scope: string;
  minFillSeconds: number;
  limits: {
    perIp: { max: number; windowSeconds: number };
    perIpUnproven: { max: number; windowSeconds: number };
  };
}

/** Null when the request may go on, otherwise the reason it may not (for the log only). */
export async function refuseLinkRequest(
  ctx: TransactionContext,
  spam: LinkRequestSpam | undefined,
  policy: LinkRequestPolicy
): Promise<string | null> {
  const now = ctx.clock.now();
  const { scope } = policy;
  if (spam?.honeypot === undefined || spam.honeypot !== '') return 'honeypot';
  const timing = await checkStartedToken(
    ctx.signer,
    spam.startedToken,
    scope,
    policy.minFillSeconds,
    now
  );
  if (timing !== 'ok') return timing === 'invalid' ? 'token-invalid' : 'too-fast';
  const proof = await checkProof(ctx.signer, spam.proof, scope, now);
  if (proof.kind === 'invalid') return 'proof-invalid';
  if (
    proof.kind === 'ok' &&
    !(await ctx.rateLimits.cooldown(`${scope}.proof:${proof.challenge}`, 24 * 3600))
  )
    return 'proof-invalid';

  // Per client address, so one client cannot walk a list of addresses; keyed hashes in
  // Postgres, shared between processes.
  const actor = ctx.principal.actor;
  const ipHash = actor.kind === 'anonymous' ? actor.ipHash : undefined;
  if (ipHash && !(await ctx.rateLimits.hit(`${scope}:ip:${ipHash}`, policy.limits.perIp)))
    return 'ip-limited';
  if (
    proof.kind === 'absent' &&
    ipHash &&
    !(await ctx.rateLimits.hit(`${scope}:unproven:${ipHash}`, policy.limits.perIpUnproven))
  )
    return 'ip-limited';
  return null;
}
