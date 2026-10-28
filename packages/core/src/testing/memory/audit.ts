// `audit_log` in memory: insertion order kept, read newest first with a keyset cursor.

import type { AuditEntry } from '../../audit/model.js';
import type { AuditLog } from '../../audit/ports.js';
import type { TenantStore } from './store.js';

const newestFirst = (a: AuditEntry, b: AuditEntry) =>
  b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id);

export function memoryAudit(s: TenantStore): AuditLog {
  return {
    record: async (entry) => void s.audit.push({ ...entry }),
    async list({ from, to, operation, actorKind, actorId, failed, cursor, limit }) {
      const at = cursor ? s.audit.find((r) => r.id === cursor) : undefined;
      return s.audit
        .filter(
          (r) =>
            (!from || r.occurredAt >= from) &&
            (!to || r.occurredAt < to) &&
            (!operation || r.operation === operation) &&
            (!actorKind || r.actorKind === actorKind) &&
            (!actorId || r.actorId === actorId) &&
            (!failed || r.result !== 'ok') &&
            (!at || newestFirst(at, r) < 0)
        )
        .sort(newestFirst)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
  };
}
