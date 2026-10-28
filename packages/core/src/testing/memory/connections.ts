// Managed connections and their intents in memory. The write and credential rules are core's
// (connections/rules.ts), called here exactly as packages/db calls them.

import type { ConnectionIntents } from '../../connections/intents.js';
import type { ConnectionRecord, ConnectionRepository } from '../../connections/ports.js';
import {
  acceptsWrite,
  credentialServes,
  dropsCredential,
  mayReadCredential,
} from '../../connections/rules.js';
import type { Principal } from '../../principal.js';
import type { TenantStore } from './store.js';

export function memoryConnections(s: TenantStore, principal: Principal): ConnectionRepository {
  /** A versioned write: refused on a stale `baseVersion` or a frozen row. */
  const write = (
    id: string,
    baseVersion: number,
    change: (row: ConnectionRecord) => Partial<ConnectionRecord>,
    at: Date
  ) => {
    const row = s.connections.get(id);
    if (!row || !acceptsWrite(row, baseVersion)) return null;
    const next = { ...row, ...change(row), version: row.version + 1, updatedAt: at };
    s.connections.set(id, next);
    return next;
  };
  return {
    get: async (id) => structuredClone(s.connections.get(id) ?? null),
    credential: async (id, version) => {
      const row = s.connections.get(id);
      return mayReadCredential(principal) && row && credentialServes(row, version)
        ? (s.connectionSecrets.get(id) ?? null)
        : null;
    },
    list: async () => [...s.connections.values()].map((row) => structuredClone(row)),
    async insert(input, at) {
      const row: ConnectionRecord = {
        ...structuredClone(input),
        state: 'paused',
        version: 1,
        credentialVersion: 0,
        hasCredential: false,
        createdAt: at,
        updatedAt: at,
      };
      s.connections.set(row.id, row);
      return structuredClone(row);
    },
    async update(id, baseVersion, changes, at) {
      const defined = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined)
      );
      return structuredClone(write(id, baseVersion, () => structuredClone(defined), at));
    },
    async state(id, baseVersion, state, at) {
      const next = write(
        id,
        baseVersion,
        (row) => ({
          state,
          hasCredential: dropsCredential(state) ? false : row.hasCredential,
        }),
        at
      );
      if (next && dropsCredential(state)) s.connectionSecrets.delete(id);
      return structuredClone(next);
    },
    async replaceCredential(id, baseVersion, secret, at) {
      const next = write(
        id,
        baseVersion,
        (row) => ({ hasCredential: true, credentialVersion: row.credentialVersion + 1 }),
        at
      );
      if (next) s.connectionSecrets.set(id, secret);
      return structuredClone(next);
    },
  };
}

export function memoryConnectionIntents(s: TenantStore): ConnectionIntents {
  return {
    get: async (id) => structuredClone(s.connectionIntents.get(id) ?? null),
    list: async (connectionId, limit) =>
      [...s.connectionIntents.values()]
        .filter((row) => row.connectionId === connectionId)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    byBusiness: async (connectionId, businessId) =>
      structuredClone(
        [...s.connectionIntents.values()].find(
          (r) => r.connectionId === connectionId && r.businessId === businessId
        ) ?? null
      ),
    async insert(row) {
      if (
        [...s.connectionIntents.values()].some(
          (r) => r.connectionId === row.connectionId && r.businessId === row.businessId
        )
      )
        return false;
      s.connectionIntents.set(row.id, structuredClone(row));
      return true;
    },
    async replace(row, revision) {
      if (s.connectionIntents.get(row.id)?.revision !== revision) return false;
      s.connectionIntents.set(row.id, structuredClone({ ...row, revision: revision + 1 }));
      return true;
    },
    async record(attempt) {
      s.connectionAttempts.push(structuredClone(attempt));
    },
    attempts: async (id) => structuredClone(s.connectionAttempts.filter((a) => a.intentId === id)),
    erased: async (id) => s.erasures.has(id),
  };
}
