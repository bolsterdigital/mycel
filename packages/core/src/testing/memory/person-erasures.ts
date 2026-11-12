// `ctx.personErasures` and the person phase of `ctx.erasures.apply()` over a MemoryStore: what
// packages/db/src/person-erasures.ts does over Postgres (ADR 034). The scrub itself is core's
// (content/people/erasure.ts); this file only finds the copies it applies to.

import type { Clock } from '../../ports.js';
import type { Principal } from '../../principal.js';
import type { PersonErasureRepository } from '../../content/ports.js';
import { scrubErasedChanges, scrubErasedCredits } from '../../content/people/erasure.js';
import type { MemoryStore, TenantStore } from './store.js';

export function memoryPersonErasures(
  s: TenantStore,
  principal: Principal,
  clock: Clock
): PersonErasureRepository {
  return {
    async register(personIds) {
      const added: string[] = [];
      for (const id of personIds)
        if (!s.personErasures.has(id)) {
          s.personErasures.set(id, {
            erasedAt: clock.now(),
            actor: structuredClone(principal.actor),
          });
          added.push(id);
        }
      return added;
    },
    // One unit of work runs at a time in memory, so there is nothing to wait for.
    async guard() {},
    async registered(ids) {
      return new Set([...ids].filter((id) => s.personErasures.has(id)));
    },
    async get(personId) {
      const row = s.personErasures.get(personId);
      return row ? { registeredAt: row.erasedAt } : null;
    },
  };
}

/** The person phase: remove the people and memberships, scrub every stored credit name. */
export function applyPersonErasures(store: MemoryStore, tenantId: string): number {
  const s = store.for(tenantId);
  const erased = new Set(s.personErasures.keys());
  if (!erased.size) return 0;
  let changed = 0;
  for (const id of erased) if (s.authors.delete(id)) changed++;
  for (const group of s.personGroups.values()) {
    const kept = group.personIds.filter((id) => !erased.has(id));
    if (kept.length !== group.personIds.length) {
      changed += group.personIds.length - kept.length;
      group.personIds = kept;
    }
  }
  for (const [id, revision] of s.revisions) {
    const document = scrubErasedCredits(revision.document, erased);
    if (document !== revision.document) {
      s.revisions.set(id, { ...revision, document });
      changed++;
    }
  }
  for (const [id, pattern] of s.patterns) {
    const blocks = scrubErasedCredits(pattern.blocks, erased);
    if (blocks !== pattern.blocks) {
      s.patterns.set(id, { ...pattern, blocks });
      changed++;
    }
  }
  for (const plan of s.bulkPlans.values())
    for (const item of plan.items) {
      const selection = scrubErasedCredits(item.selection, erased);
      const candidate = scrubErasedCredits(item.preview.candidate, erased);
      const changes = scrubErasedChanges(item.preview.changes, candidate, erased);
      if (
        selection !== item.selection ||
        candidate !== item.preview.candidate ||
        changes !== item.preview.changes
      ) {
        item.selection = selection;
        item.preview = { ...item.preview, candidate, changes };
        changed++;
      }
    }
  for (const media of s.media.values()) {
    const credit = scrubErasedCredits(media.credit, erased);
    if (credit !== media.credit) {
      media.credit = credit;
      changed++;
    }
  }
  return changed;
}
