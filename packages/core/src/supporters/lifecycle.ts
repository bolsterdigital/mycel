// Durable evidence distinguishes explicit readmission from delayed old facts (ADR 032).
// Rejected: receipt/occurrence time as permission, or keeping an address in the register.
import { carriesErasedAddress } from './erasure.js';
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
