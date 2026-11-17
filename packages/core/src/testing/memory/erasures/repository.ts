// `ctx.erasures` over a MemoryStore: what packages/db/src/erasures.ts does over Postgres, on the
// same rows (ADR 019 rule 8). The decisions (intent state, tombstone, archive expiry) are core's,
// in supporters/erasure.ts; this file only finds the rows they apply to.

import {
  holderSubmissions,
  liveLifecycle,
  protectsErasureCopy,
  sparesHolderCopy,
  admissionFor,
  allowsLifecycle,
} from '../../../supporters/lifecycle.js';
import type { Principal } from '../../../principal.js';
import type { Clock, Erasures } from '../../../ports.js';
import { emailKey } from '../../../supporters/email-key.js';
import {
  carriesErasedAddress,
  eraseOutboxProps,
  ERASURE_EXPORT_ERROR,
  erasedIntentState,
  expiresOnErasure,
  isTombstone,
  tombstoneEmail,
} from '../../../supporters/erasure.js';
import { normalizeEmail } from '../../../util/email.js';
import type { MemoryStore } from '../store.js';
import { applyPersonErasures } from './people.js';

/**
 * The register is kept by supporter id and address hash; the addresses to erase are found from
 * it at apply time (the supporter's projection and events, and any value whose hash is
 * registered) and never kept.
 */
export function memoryErasures(store: MemoryStore, principal: Principal, clock: Clock): Erasures {
  const tenantId = principal.tenantId;
  const s = store.for(tenantId);
  const evidence = () => registrationsOf(s.erasures);
  return {
    async admit(email, submissionId, at) {
      const hash = await emailKey(tenantId, email, 'erasure');
      const id = admissionFor(
        hash,
        submissionId,
        at,
        evidence(),
        [...s.supporterLifecycles.values()],
        new Set([...s.projections.values()].filter((p) => p.email !== email).map((p) => p.id))
      );
      if (!id || s.supporterLifecycles.has(id)) return id;
      s.supporterLifecycles.set(id, {
        id,
        emailHash: hash,
        submissionId,
        startedAt: at,
      });
      return id;
    },
    async allows(email, lifecycleId) {
      const hash = await emailKey(tenantId, email, 'erasure');
      return allowsLifecycle(hash, lifecycleId, evidence(), [...s.supporterLifecycles.values()]);
    },
    async carried(supporterId) {
      const rows = [
        ...[...s.projections.values()].filter((p) => p.id === supporterId),
        ...[...s.events.values()].filter((e) => e.supporter_id === supporterId),
      ];
      return [...new Set(rows.map((r) => normalizeEmail(r.email)).filter((a) => !isTombstone(a)))];
    },
    async heldByOthers(supporterId, addresses) {
      const wanted = new Set(addresses.map(normalizeEmail));
      const held = new Set<string>();
      const consider = (owner: string | undefined, email: string) => {
        const address = normalizeEmail(email);
        if (owner && owner !== supporterId && !s.erasures.has(owner) && wanted.has(address))
          held.add(address);
      };
      for (const p of s.projections.values()) consider(p.id, p.email);
      for (const e of s.events.values()) consider(e.supporter_id, e.email);
      return [...held];
    },
    async register(supporterId, email, older = []) {
      if (s.erasures.has(supporterId)) return;
      const emailHash = await emailKey(tenantId, email, 'erasure');
      const olderHashes = new Set<string>();
      for (const a of older) olderHashes.add(await emailKey(tenantId, a, 'erasure'));
      olderHashes.delete(emailHash);
      s.erasures.set(supporterId, {
        emailHash,
        ...(olderHashes.size ? { olderHashes: [...olderHashes] } : {}),
        erasedAt: clock.now(),
        actor: structuredClone(principal.actor),
      });
    },
    async get(supporterId) {
      const e = s.erasures.get(supporterId);
      return e ? { registeredAt: e.erasedAt, secured: s.erasureBackups.has(supporterId) } : null;
    },
    async apply() {
      // ADR 034: the person phase runs in the same apply as the supporter phase.
      let changed = applyPersonErasures(store, tenantId);
      if (s.erasures.size) changed += await applyErasures(store, tenantId, clock);
      // Archives that may hold a registered person (TODO #28), as packages/db/src/erasures.ts.
      const times = [...s.erasures.values(), ...s.personErasures.values()].map((e) =>
        e.erasedAt.getTime()
      );
      if (!times.length) return changed;
      const newest = new Date(Math.max(...times));
      for (const x of s.exports.values())
        if (expiresOnErasure(x, changed > 0, newest)) {
          Object.assign(x, {
            status: 'expired',
            error: ERASURE_EXPORT_ERROR,
            expiresAt: clock.now(),
          });
          changed++;
        }
      return changed;
    },
    async status() {
      let oldest: Date | null = null;
      for (const [id, e] of s.erasures)
        if (!s.erasureBackups.has(id) && (!oldest || e.erasedAt < oldest)) oldest = e.erasedAt;
      return {
        registered: s.erasures.size,
        secured: [...s.erasures.keys()].filter((id) => s.erasureBackups.has(id)).length,
        oldestUnsecuredAt: oldest,
      };
    },
  };
}

/** The register as Postgres holds it: one boundary per id and address hash (0058). */
const registrationsOf = (erasures: ReturnType<MemoryStore['for']>['erasures']) =>
  [...erasures].flatMap(([supporterId, r]) =>
    [r.emailHash, ...(r.olderHashes ?? [])].map((emailHash) => ({
      supporterId,
      emailHash,
      erasedAt: r.erasedAt,
    }))
  );

/**
 * Every address apply erases: any value whose hash is registered, and what the registered ids'
 * own rows carry. `carriedOnly` are those of the second kind no registration ends: an older
 * address another supporter held at the request (or a register from before 0058).
 */
async function registeredAddresses(
  store: MemoryStore,
  tenantId: string
): Promise<{ addresses: Set<string>; carriedOnly: Set<string> }> {
  const s = store.for(tenantId);
  const ids = new Set(s.erasures.keys());
  const hashes = new Set(registrationsOf(s.erasures).map((e) => e.emailHash));
  const addresses = new Set<string>();
  const consider = async (value: string) => {
    if (
      value.includes('@') &&
      !isTombstone(value) &&
      hashes.has(await emailKey(tenantId, value, 'erasure'))
    )
      addresses.add(normalizeEmail(value));
  };
  for (const p of s.projections.values())
    if (ids.has(p.id) && !isTombstone(p.email)) addresses.add(normalizeEmail(p.email));
    else await consider(p.email);
  for (const e of s.events.values())
    if (e.supporter_id && ids.has(e.supporter_id) && !isTombstone(e.email))
      addresses.add(normalizeEmail(e.email));
    else await consider(e.email);
  for (const sub of s.submissions.values())
    for (const v of Object.values(sub.values)) if (typeof v === 'string') await consider(v);
  const carriedOnly = new Set<string>();
  for (const a of addresses)
    if (!hashes.has(await emailKey(tenantId, a, 'erasure'))) carriedOnly.add(a);
  return { addresses, carriedOnly };
}

/** The scrub itself; returns the number of rows changed, like the SQL. */
async function applyErasures(store: MemoryStore, tenantId: string, clock: Clock): Promise<number> {
  const s = store.for(tenantId);
  let changed = 0;
  for (const [id, row] of s.mailchimpReceipts)
    if (s.erasures.has(row.supporterId)) {
      s.mailchimpReceipts.delete(id);
      changed++;
    }
  for (const row of s.connectionIntents.values())
    if (row.supporterId && s.erasures.has(row.supporterId)) {
      changed++;
      row.supporterId = null;
      row.state = erasedIntentState(row.state);
      row.failure = 'erasure';
      row.revision += 1;
      row.leaseToken = null;
      row.leaseUntil = null;
    }
  const ids = new Set(s.erasures.keys());
  // ADR 033 rule 8, as 0049's apply: the rows go, the active ones join the anonymous count.
  for (const [k, p] of s.participations)
    if (ids.has(p.supporterId)) {
      const campaign = s.campaigns.get(p.campaignId);
      if (campaign && !p.withdrawnAt) campaign.erasedCount += 1;
      s.participations.delete(k);
      changed++;
    }
  const registrations = registrationsOf(s.erasures);
  const live = new Map(
    [...s.supporterLifecycles.values()]
      .filter((l) => liveLifecycle(l, registrations))
      .map((l) => [l.id, l])
  );
  const { addresses, carriedOnly } = await registeredAddresses(store, tenantId);
  // By address only where a registration ended it; a row of another id on a carried-only address
  // is that supporter's, and so is a copy of a submission her events refer to.
  const ended = (email: string) => {
    const address = normalizeEmail(email);
    return addresses.has(address) && !carriedOnly.has(address);
  };
  const held = holderSubmissions(s.events.values(), ids, carriedOnly);
  const spared = (value: unknown, submissionId: unknown) =>
    sparesHolderCopy(value, submissionId, held, addresses);
  const carries = (value: unknown) => carriesErasedAddress(value, addresses);
  const hashes = new Map(
    await Promise.all(
      [...addresses].map(async (a) => [a, await emailKey(tenantId, a, 'erasure')] as const)
    )
  );
  const proven = (value: unknown, provenance: unknown) =>
    protectsErasureCopy(value, provenance, live, hashes);

  for (const e of s.events.values()) {
    const owner = e.supporter_id ?? '';
    if (live.has(owner) || !(ids.has(owner) || ended(e.email))) continue;
    const tomb = tombstoneEmail(owner || e.id);
    if (e.email === tomb && !Object.keys(e.props).length) continue;
    e.email = tomb;
    e.props = {};
    changed++;
  }
  for (const p of s.projections.values()) {
    if (live.has(p.id) || !(ids.has(p.id) || ended(p.email))) continue;
    const tomb = tombstoneEmail(p.id);
    if (p.email === tomb && !p.lists.length && !p.pendingLists.length && !p.grants.length) continue;
    Object.assign(p, { email: tomb, lists: [], pendingLists: [], grants: [] });
    changed++;
  }
  // Mail intents and their reconcile jobs hang off the outbox event that carried the address;
  // find them before the scrub below takes the address out of that event.
  const tenantOutbox = store.outbox.filter((e) => e.tenantId === tenantId);
  const eventIds = new Set<string>();
  for (const e of tenantOutbox)
    if (carries(e.props) && !proven(e.props, e.props) && !spared(e.props, e.props['submissionId']))
      eventIds.add(e.id);
  for (const [key, send] of s.mailSends)
    if (eventIds.has(send.eventId) && s.mailSends.delete(key)) changed++;
  for (const [id, sub] of s.submissions)
    if (
      carries(sub.values) &&
      !proven(sub.values, sub.evaluation) &&
      !spared(sub.values, id) &&
      s.submissions.delete(id)
    )
      changed++;
  // A seat reserved for a signup that was never ingested.
  for (const a of addresses)
    if (
      ![...live.values()].some((l) => l.emailHash === hashes.get(a)) &&
      s.admissions.delete(await emailKey(tenantId, a, 'admission'))
    )
      changed++;
  for (const e of tenantOutbox)
    if (eventIds.has(e.id)) {
      e.props = eraseOutboxProps(e.type, e.props);
      changed++;
    }
  for (let i = store.jobs.length - 1; i >= 0; i--) {
    const job = store.jobs[i]!;
    const eventId = (job.payload as { eventId?: unknown } | null)?.eventId;
    if (
      job.tenantId === tenantId &&
      (carries(job.payload) ||
        (job.type === 'mail.reconcile' && typeof eventId === 'string' && eventIds.has(eventId)))
    ) {
      store.jobs.splice(i, 1);
      changed++;
    }
  }
  return changed;
}

/**
 * What a backup run does over Postgres (docker/backup/backup.sh, 0021): every registration of the
 * tenant that is in the register now is held by snapshot `snapshotId`. Existing rows stay.
 */
export function secureErasures(
  store: MemoryStore,
  tenantId: string,
  snapshotId: string,
  at: Date
): void {
  const s = store.for(tenantId);
  for (const id of s.erasures.keys())
    if (!s.erasureBackups.has(id)) s.erasureBackups.set(id, { snapshotId, securedAt: at });
}
