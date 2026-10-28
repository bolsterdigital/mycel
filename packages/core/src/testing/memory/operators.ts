// Operators, memberships and API keys in memory: the tenant-scoped repositories and the
// authentication-time `IdentityStore` that reads across tenants.

import type { TenantAccess } from '../../entitlements/model.js';
import type { ApiKeySummary, Member, Operator } from '../../operators/model.js';
import type {
  ApiKeyRecord,
  ApiKeyRepository,
  IdentityStore,
  LoginClaims,
  MembershipRepository,
  OperatorMembership,
  OperatorRepository,
} from '../../operators/ports.js';
import type { Clock, Ids } from '../../ports.js';
import { normalizeEmail } from '../../util/email.js';
import { FakeClock, MemoryTenants, SequentialIds } from './fakes.js';
import type { MemoryStore, OperatorRow, StoredApiKey, TenantStore } from './store.js';

/** `ctx.operators`: an invite finds or creates the platform-wide operator row. */
export function memoryOperators(rows: Map<string, OperatorRow>): OperatorRepository {
  return {
    async forInvite(email, newId) {
      const all = [...rows.values()];
      const pending = all.find((o) => o.subject === null && o.email === email);
      if (pending) return { id: pending.id };
      const verified = all.filter(
        (o) => o.subject !== null && o.email === email && o.emailVerifiedAt
      );
      if (verified.length > 1) return 'ambiguous';
      if (verified[0]) return { id: verified[0].id };
      rows.set(newId, {
        id: newId,
        issuer: null,
        subject: null,
        email,
        emailVerifiedAt: null,
        name: null,
        lastLoginAt: null,
      });
      return { id: newId };
    },
  };
}

/** `ctx.members`; `lock` is the tenant's membership lock of the current run (TODO #20a). */
export function memoryMembers(
  s: TenantStore,
  operators: Map<string, OperatorRow>,
  lock: () => Promise<void>
): MembershipRepository {
  const memberOf = (operatorId: string): Member | null => {
    const m = s.members.get(operatorId);
    const o = operators.get(operatorId);
    return m && o
      ? {
          operatorId,
          email: o.email,
          name: o.name,
          capabilities: [...m.capabilities],
          pending: o.lastLoginAt === null,
        }
      : null;
  };
  return {
    lock,
    list: async () =>
      [...s.members.keys()]
        .map(memberOf)
        .filter((m): m is Member => m !== null)
        .sort((a, b) => a.email.localeCompare(b.email)),
    get: async (operatorId) => memberOf(operatorId),
    findByEmail: async (email) =>
      [...s.members.keys()].map(memberOf).find((m) => m?.email === email) ?? null,
    async insert(operatorId, capabilities, at) {
      s.members.set(operatorId, { capabilities: [...capabilities], createdAt: new Date(at) });
    },
    async update(operatorId, capabilities) {
      const m = s.members.get(operatorId);
      if (!m) return false;
      m.capabilities = [...capabilities];
      return true;
    },
    remove: async (operatorId) => s.members.delete(operatorId),
  };
}

const summary = (k: StoredApiKey) =>
  ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    capabilities: [...k.capabilities],
    createdBy: structuredClone(k.createdBy),
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  }) satisfies ApiKeySummary;

export function memoryApiKeys(s: TenantStore): ApiKeyRepository {
  return {
    list: async () => [...s.apiKeys.values()].sort((a, b) => b.id.localeCompare(a.id)).map(summary),
    async insert(key) {
      s.apiKeys.set(key.id, { ...structuredClone(key), lastUsedAt: null, revokedAt: null });
    },
    async revoke(id, at) {
      const k = s.apiKeys.get(id);
      if (!k || k.revokedAt) return false;
      k.revokedAt = new Date(at);
      return true;
    },
    createdBy: async (operatorId) =>
      [...s.apiKeys.values()]
        .filter(
          (k) =>
            !k.revokedAt && k.createdBy.kind === 'operator' && k.createdBy.operatorId === operatorId
        )
        .map(summary),
    async touch(id, at) {
      const k = s.apiKeys.get(id);
      if (k && (!k.lastUsedAt || at.getTime() - k.lastUsedAt.getTime() >= 60_000))
        k.lastUsedAt = new Date(at);
    },
  };
}

/**
 * The authentication-time view over a MemoryStore, like `createIdentityStore` over Postgres: it
 * reads every tenant's memberships and keys, which only this port may do (ADR 011 rule 1).
 */
export class MemoryIdentityStore implements IdentityStore {
  constructor(
    readonly store: MemoryStore,
    readonly tenants: MemoryTenants,
    readonly clock: Clock = new FakeClock(),
    readonly ids: Ids = new SequentialIds()
  ) {}

  async login(claims: LoginClaims): Promise<Operator> {
    const email = normalizeEmail(claims.email);
    const now = this.clock.now();
    const rows = [...this.store.operators.values()];
    let row = rows.find((o) => o.issuer === claims.issuer && o.subject === claims.subject);
    if (row) {
      row.emailVerifiedAt = claims.emailVerified
        ? row.email === email && row.emailVerifiedAt
          ? row.emailVerifiedAt
          : now
        : null;
      row.email = email;
      row.name = claims.name ?? row.name;
      row.lastLoginAt = now;
    } else {
      const pending = claims.emailVerified
        ? rows.find((o) => o.subject === null && o.email === email)
        : undefined;
      row = pending ?? {
        id: this.ids.next(),
        issuer: null,
        subject: null,
        email,
        emailVerifiedAt: null,
        name: null,
        lastLoginAt: null,
      };
      Object.assign(row, {
        issuer: claims.issuer,
        subject: claims.subject,
        emailVerifiedAt: claims.emailVerified ? now : null,
        name: claims.name ?? null,
        lastLoginAt: now,
      });
      this.store.operators.set(row.id, row);
    }
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    };
  }

  async membershipsOf(operatorId: string): Promise<OperatorMembership[]> {
    const out: OperatorMembership[] = [];
    for (const [tenantId, t] of this.store.tenants) {
      const m = t.members.get(operatorId);
      const info = await this.tenants.findById(tenantId);
      if (m && info)
        out.push({ tenantId, slug: info.slug, name: info.name, capabilities: [...m.capabilities] });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async apiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const [tenantId, t] of this.store.tenants)
      for (const k of t.apiKeys.values())
        if (k.keyHash === hash)
          return { id: k.id, tenantId, capabilities: [...k.capabilities], revokedAt: k.revokedAt };
    return null;
  }

  async tenantAccess(tenantId: string): Promise<TenantAccess> {
    return this.store.accessOf(tenantId);
  }

  async loginAttempt(key: string, { max, windowSeconds }: { max: number; windowSeconds: number }) {
    const windowMs = windowSeconds * 1000;
    const slot = `${key}:${Math.floor(this.clock.now().getTime() / windowMs)}`;
    const hits = (this.store.loginAttempts.get(slot) ?? 0) + 1;
    this.store.loginAttempts.set(slot, hits);
    return hits <= max;
  }
}
