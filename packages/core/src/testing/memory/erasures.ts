// `ctx.erasures` over a MemoryStore: what packages/db/src/erasures.ts does over Postgres, on the
// same rows (ADR 019 rule 8). The decisions (intent state, tombstone, archive expiry) are core's,
// in supporters/erasure.ts; this file only finds the rows they apply to.

import type { Principal } from '../../principal.js';
import type { Clock, Erasures } from '../../ports.js';
import {
  ERASURE_EXPORT_ERROR,
  erasedIntentState,
  erasureEmailHash,
  expiresOnErasure,
  isTombstone,
  tombstoneEmail,
} from '../../supporters/erasure.js';
import { scrubText } from '../../util/scrub.js';
import type { MemoryStore } from './store.js';

/**
 * The register is kept by supporter id and address hash; the addresses to erase are found from
 * it at apply time (the supporter's projection and events, and any value whose hash is
 * registered) and never kept.
 */
export function memoryErasures(store: MemoryStore, principal: Principal, clock: Clock): Erasures {
  const tenantId = principal.tenantId;
  const s = store.for(tenantId);
  return {
    async register(supporterId, email) {
      if (s.erasures.has(supporterId)) return;
      s.erasures.set(supporterId, {
        emailHash: await erasureEmailHash(tenantId, email),
        erasedAt: clock.now(),
        actor: structuredClone(principal.actor),
      });
    },
    apply: async () => (s.erasures.size ? applyErasures(store, tenantId, clock) : 0),
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

/** Every registered address, from the register's ids and from any value whose hash matches. */
async function registeredAddresses(store: MemoryStore, tenantId: string): Promise<Set<string>> {
  const s = store.for(tenantId);
  const ids = new Set(s.erasures.keys());
  const hashes = new Set([...s.erasures.values()].map((e) => e.emailHash));
  const addresses = new Set<string>();
  const consider = async (value: string) => {
    if (
      value.includes('@') &&
      !isTombstone(value) &&
      hashes.has(await erasureEmailHash(tenantId, value))
    )
      addresses.add(value.trim().toLowerCase());
  };
  for (const p of s.projections.values())
    if (ids.has(p.id) && !isTombstone(p.email)) addresses.add(p.email.toLowerCase());
    else await consider(p.email);
  for (const e of s.events.values())
    if (e.supporter_id && ids.has(e.supporter_id) && !isTombstone(e.email))
      addresses.add(e.email.toLowerCase());
    else await consider(e.email);
  for (const sub of s.submissions.values())
    for (const v of Object.values(sub.values)) if (typeof v === 'string') await consider(v);
  return addresses;
}

/** The scrub itself; returns the number of rows changed, like the SQL. */
async function applyErasures(store: MemoryStore, tenantId: string, clock: Clock): Promise<number> {
  const s = store.for(tenantId);
  let changed = 0;
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
  const addresses = await registeredAddresses(store, tenantId);
  const carries = (value: unknown) => {
    const text = JSON.stringify(value).toLowerCase();
    return [...addresses].some((a) => text.includes(a));
  };

  for (const e of s.events.values()) {
    const owner = e.supporter_id ?? '';
    if (!(ids.has(owner) || addresses.has(e.email.toLowerCase()))) continue;
    const tomb = tombstoneEmail(owner || e.id);
    if (e.email === tomb && !Object.keys(e.props).length) continue;
    e.email = tomb;
    e.props = {};
    changed++;
  }
  for (const p of s.projections.values()) {
    if (!(ids.has(p.id) || addresses.has(p.email.toLowerCase()))) continue;
    const tomb = tombstoneEmail(p.id);
    if (p.email === tomb && !p.lists.length && !p.pendingLists.length) continue;
    Object.assign(p, { email: tomb, lists: [], pendingLists: [] });
    changed++;
  }
  // Mail intents and their reconcile jobs hang off the outbox event that carried the address;
  // find them before the scrub below takes the address out of that event.
  const tenantOutbox = store.outbox.filter((e) => e.tenantId === tenantId);
  const eventIds = new Set(tenantOutbox.filter((e) => carries(e.props)).map((e) => e.id));
  for (const [key, send] of s.mailSends)
    if (eventIds.has(send.eventId) && s.mailSends.delete(key)) changed++;
  for (const [id, sub] of s.submissions)
    if (carries(sub.values) && s.submissions.delete(id)) changed++;
  for (const e of tenantOutbox)
    if (carries(e.props)) {
      e.props = JSON.parse(scrubText(JSON.stringify(e.props))) as Record<string, unknown>;
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
  // Archives that may hold a registered person (TODO #28), as packages/db/src/erasures.ts.
  const newest = new Date(Math.max(...[...s.erasures.values()].map((e) => e.erasedAt.getTime())));
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
