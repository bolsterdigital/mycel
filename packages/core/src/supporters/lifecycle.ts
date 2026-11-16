// Durable evidence distinguishes explicit readmission from delayed old facts (ADR 032).
// Rejected: receipt/occurrence time as permission, or keeping an address in the register.
import { carriesErasedAddress } from './erasure.js';
import { normalizeEmail } from '../util/email.js';
import type { DomainEvent, TransactionContext } from '../ports.js';

export interface SupporterLifecycle {
  id: string;
  emailHash: string;
  submissionId: string;
  startedAt: Date;
}
export interface ErasureBoundary {
  supporterId: string;
  emailHash: string;
  erasedAt: Date;
}

export function liveLifecycle(
  lifecycle: SupporterLifecycle,
  registrations: readonly ErasureBoundary[]
): boolean {
  return !registrations.some(
    (r) =>
      r.supporterId === lifecycle.id ||
      (r.emailHash === lifecycle.emailHash && r.erasedAt >= lifecycle.startedAt)
  );
}

/** Outbox payload provenance is server-owned; arbitrary jobs have no exemption. */
export function lifecycleOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>)['supporterLifecycleId'];
  return typeof id === 'string' ? id : undefined;
}

/** Called inside the same transaction/lock as a new claim, not just while rendering a mail. */
export async function erasureAllowsEvent(
  ctx: TransactionContext,
  event: Pick<DomainEvent, 'props'>
) {
  const email = event.props['email'];
  if (typeof email !== 'string') return true;
  await ctx.supporters.lock(email);
  return ctx.erasures.allows(email, lifecycleOf(event.props));
}

/** The first explicit submission owns the fresh id; subsequent signups share that lifecycle. */
export function admissionFor(
  hash: string,
  submissionId: string,
  at: Date,
  registrations: readonly ErasureBoundary[],
  lifecycles: readonly SupporterLifecycle[],
  movedIds: ReadonlySet<string> = new Set()
): string | undefined | null {
  const ended = registrations.filter((r) => r.emailHash === hash);
  if (!ended.length) return undefined;
  if (ended.some((r) => r.erasedAt >= at)) return null;
  return (
    lifecycles.find(
      (l) => l.emailHash === hash && !movedIds.has(l.id) && liveLifecycle(l, registrations)
    )?.id ?? submissionId
  );
}

export function allowsLifecycle(
  hash: string,
  lifecycleId: string | undefined,
  registrations: readonly ErasureBoundary[],
  lifecycles: readonly SupporterLifecycle[]
): boolean {
  return (
    !registrations.some((r) => r.emailHash === hash) ||
    lifecycles.some(
      (l) => l.id === lifecycleId && l.emailHash === hash && liveLifecycle(l, registrations)
    )
  );
}

/**
 * The submissions another supporter's events refer to, on an address the erased supporter's rows
 * merely carry (no registration ends it): the evidence that a copy on that address is the other
 * supporter's (ADR 032 rule 4, second amendment of 2026-11-16). Maps submission id to address.
 * Rejected: sparing every copy on an address somebody else holds (the erased supporter's own
 * submissions on it would stay), and a cut on creation time (rule 2 trusts no timestamp).
 */
export function holderSubmissions(
  events: Iterable<{
    supporter_id?: string | null | undefined;
    email: string;
    source_ref: string;
  }>,
  registeredIds: ReadonlySet<string>,
  carriedOnly: ReadonlySet<string>
): Map<string, string> {
  const held = new Map<string, string>();
  for (const e of events) {
    const address = normalizeEmail(e.email);
    if (!e.supporter_id || registeredIds.has(e.supporter_id) || !carriedOnly.has(address)) continue;
    if (e.source_ref.startsWith('submission:'))
      held.set(e.source_ref.slice('submission:'.length), address);
  }
  return held;
}

/** As a lifecycle: the other supporter's submission exempts its own address only. */
export function sparesHolderCopy(
  value: unknown,
  submissionId: unknown,
  held: ReadonlyMap<string, string>,
  addresses: Iterable<string>
): boolean {
  const own = typeof submissionId === 'string' ? held.get(submissionId) : undefined;
  if (own === undefined) return false;
  let matched = false;
  for (const address of addresses) {
    if (!carriesErasedAddress(value, new Set([address]))) continue;
    if (address !== own) return false;
    matched = true;
  }
  return matched;
}

/** A lifecycle exempts only its own address, never a second erased address in the same copy. */
export function protectsErasureCopy(
  value: unknown,
  provenance: unknown,
  live: ReadonlyMap<string, SupporterLifecycle>,
  hashes: ReadonlyMap<string, string>
): boolean {
  const lifecycle = live.get(lifecycleOf(provenance) ?? '');
  if (!lifecycle) return false;
  let matched = false;
  for (const [address, hash] of hashes) {
    if (!carriesErasedAddress(value, new Set([address]))) continue;
    if (lifecycle.emailHash !== hash) return false;
    matched = true;
  }
  return matched;
}
