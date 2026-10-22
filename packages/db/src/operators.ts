// Operators, memberships and API keys over Postgres (TODO #7, migration 0007). Two halves:
//
// * The repositories run in a use case's tenant transaction as mycel_app, like those in
//   repositories.ts: memberships and keys under RLS, operators only through the `member_read`
//   policy and the `operator_for_invite` function.
// * `createIdentityStore` answers authentication before a tenant context exists. Each call is one
//   transaction that switches to `mycel_auth` with `set local role`, the pattern of
//   `drainOutbox` (mycel_worker) and `sweepRateLimits` (mycel_janitor). Its connection is the
//   `mycel_authenticator` login, which can do nothing but enter that role.

import { sql, type Kysely } from 'kysely';
import {
  Actor,
  DEFAULT_ACCESS,
  TenantStatus,
  effectiveEntitlements,
  normalizeEmail,
  type ApiKeyRepository,
  type ApiKeySummary,
  type Capability,
  type IdentityStore,
  type Ids,
  type KeyCapability,
  type Member,
  type MembershipRepository,
  type Operator,
  type OperatorRepository,
} from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export function operatorRepository(trx: Trx): OperatorRepository {
  return {
    async forInvite(email, newId) {
      const { rows } = await sql<{ id: string | null }>`
        select operator_for_invite(${email}, ${newId}::uuid) as id`.execute(trx);
      const id = rows[0]?.id ?? null;
      return id === null ? 'ambiguous' : { id };
    },
  };
}

export function membershipRepository(trx: Trx, tenantId: string): MembershipRepository {
  // Operators are visible to mycel_app exactly when they are members of this tenant (0007).
  const members = () =>
    trx
      .selectFrom('tenant_memberships as m')
      .innerJoin('operators as o', 'o.id', 'm.operator_id')
      .select(['m.operator_id', 'm.capabilities', 'o.email', 'o.name', 'o.last_login_at']);
  const toMember = (r: {
    operator_id: string;
    capabilities: string[];
    email: string;
    name: string | null;
    last_login_at: Date | string | null;
  }): Member => ({
    operatorId: r.operator_id,
    email: r.email,
    name: r.name,
    capabilities: r.capabilities as Capability[],
    pending: r.last_login_at === null,
  });
  return {
    async lock() {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`members:${tenantId}`}, 0))`.execute(
        trx
      );
    },
    async list() {
      return (await members().orderBy('o.email').orderBy('m.operator_id').execute()).map(toMember);
    },
    async get(operatorId) {
      const r = await members().where('m.operator_id', '=', operatorId).executeTakeFirst();
      return r ? toMember(r) : null;
    },
    async findByEmail(email) {
      const r = await members().where('o.email', '=', email).executeTakeFirst();
      return r ? toMember(r) : null;
    },
    async insert(operatorId, capabilities, at) {
      await trx
        .insertInto('tenant_memberships')
        .values({ tenant_id: tenantId, operator_id: operatorId, capabilities, created_at: at })
        .execute();
    },
    async update(operatorId, capabilities) {
      const r = await trx
        .updateTable('tenant_memberships')
        .set({ capabilities })
        .where('operator_id', '=', operatorId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async remove(operatorId) {
      const r = await trx
        .deleteFrom('tenant_memberships')
        .where('operator_id', '=', operatorId)
        .executeTakeFirst();
      return r.numDeletedRows > 0n;
    },
  };
}

export function apiKeyRepository(trx: Trx, tenantId: string): ApiKeyRepository {
  const columns = [
    'id',
    'name',
    'prefix',
    'capabilities',
    'created_by',
    'created_at',
    'last_used_at',
    'revoked_at',
  ] as const;
  const toSummary = (r: {
    id: string;
    name: string;
    prefix: string;
    capabilities: string[];
    created_by: unknown;
    created_at: Date | string;
    last_used_at: Date | string | null;
    revoked_at: Date | string | null;
  }): ApiKeySummary => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    capabilities: r.capabilities as KeyCapability[],
    createdBy: Actor.parse(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  });
  return {
    async list() {
      return (await trx.selectFrom('api_keys').select(columns).orderBy('id', 'desc').execute()).map(
        toSummary
      );
    },
    async insert(key) {
      await trx
        .insertInto('api_keys')
        .values({
          id: key.id,
          tenant_id: tenantId,
          name: key.name,
          prefix: key.prefix,
          key_hash: key.keyHash,
          capabilities: key.capabilities,
          created_by: JSON.stringify(key.createdBy),
          created_at: key.createdAt,
        })
        .execute();
    },
    async revoke(id, at) {
      const r = await trx
        .updateTable('api_keys')
        .set({ revoked_at: at })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async createdBy(operatorId) {
      return (
        await trx
          .selectFrom('api_keys')
          .select(columns)
          .where('revoked_at', 'is', null)
          .where(
            sql<boolean>`created_by @> ${JSON.stringify({ kind: 'operator', operatorId })}::jsonb`
          )
          .execute()
      ).map(toSummary);
    },
    async touch(id, at) {
      await trx
        .updateTable('api_keys')
        .set({ last_used_at: at })
        .where('id', '=', id)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<', sql<Date>`${at}::timestamptz - interval '1 minute'`),
          ])
        )
        .execute();
    },
  };
}

interface OperatorRow {
  id: string;
  email: string;
  name: string | null;
  email_verified_at: Date | string | null;
  last_login_at: Date | string | null;
}

const toOperator = (r: OperatorRow): Operator => ({
  id: r.id,
  email: r.email,
  name: r.name,
  emailVerifiedAt: iso(r.email_verified_at),
  lastLoginAt: iso(r.last_login_at),
});

/**
 * Authentication-time reads and the login write, as `mycel_auth`. `authDb` connects as
 * `mycel_authenticator` (AUTH_DATABASE_URL); the operator connection works too and is what the
 * database tests use, because it is also a member of mycel_auth (0007).
 */
export function createIdentityStore(authDb: Kysely<Database>, ids: Ids): IdentityStore {
  const asAuth = <T>(fn: (trx: Trx) => Promise<T>): Promise<T> =>
    authDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_auth`.execute(trx);
      return fn(trx);
    });
  const returning = ['id', 'email', 'name', 'email_verified_at', 'last_login_at'] as const;

  return {
    login(claims) {
      const email = normalizeEmail(claims.email);
      const name = claims.name ?? null;
      return asAuth(async (trx) => {
        const known = await trx
          .selectFrom('operators')
          .select(['id', 'email', 'email_verified_at'])
          .where('issuer', '=', claims.issuer)
          .where('subject', '=', claims.subject)
          .forUpdate()
          .executeTakeFirst();
        if (known) {
          // Verification belongs to an address: a changed or unverified address loses it.
          const verifiedAt = !claims.emailVerified
            ? null
            : known.email === email && known.email_verified_at
              ? known.email_verified_at
              : sql<Date>`now()`;
          const row = await trx
            .updateTable('operators')
            .set({
              email,
              name: name ?? sql<string | null>`name`,
              email_verified_at: verifiedAt,
              last_login_at: sql<Date>`now()`,
            })
            .where('id', '=', known.id)
            .returning(returning)
            .executeTakeFirstOrThrow();
          return toOperator(row);
        }
        if (claims.emailVerified) {
          // A verified address claims its pending invitation. FOR UPDATE: of two first logins
          // racing for one invitation, the second finds it linked and becomes a new operator.
          const claimed = await trx
            .updateTable('operators')
            .set({
              issuer: claims.issuer,
              subject: claims.subject,
              email_verified_at: sql<Date>`now()`,
              name,
              last_login_at: sql<Date>`now()`,
            })
            .where(
              'id',
              '=',
              trx
                .selectFrom('operators')
                .select('id')
                .where('subject', 'is', null)
                .where('email', '=', email)
                .forUpdate()
            )
            .where('subject', 'is', null)
            .returning(returning)
            .executeTakeFirst();
          if (claimed) return toOperator(claimed);
        }
        const row = await trx
          .insertInto('operators')
          .values({
            id: ids.next(),
            issuer: claims.issuer,
            subject: claims.subject,
            email,
            email_verified_at: claims.emailVerified ? sql<Date>`now()` : null,
            name,
            last_login_at: sql<Date>`now()`,
          })
          // Two first logins of one subject at once: the second updates what the first made.
          .onConflict((oc) =>
            oc.columns(['issuer', 'subject']).doUpdateSet({ last_login_at: sql<Date>`now()` })
          )
          .returning(returning)
          .executeTakeFirstOrThrow();
        return toOperator(row);
      });
    },

    membershipsOf(operatorId) {
      return asAuth(async (trx) =>
        (
          await trx
            .selectFrom('tenant_memberships as m')
            .innerJoin('tenants as t', 't.id', 'm.tenant_id')
            .select(['m.tenant_id', 't.slug', 't.name', 'm.capabilities'])
            .where('m.operator_id', '=', operatorId)
            .orderBy('t.slug')
            .execute()
        ).map((r) => ({
          tenantId: r.tenant_id,
          slug: r.slug,
          name: r.name,
          capabilities: r.capabilities as Capability[],
        }))
      );
    },

    apiKeyByHash(hash) {
      return asAuth(async (trx) => {
        const r = await trx
          .selectFrom('api_keys')
          .select(['id', 'tenant_id', 'capabilities', 'revoked_at'])
          .where('key_hash', '=', hash)
          .executeTakeFirst();
        return r
          ? {
              id: r.id,
              tenantId: r.tenant_id,
              capabilities: r.capabilities as KeyCapability[],
              revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at),
            }
          : null;
      });
    },

    tenantAccess(tenantId) {
      return asAuth(async (trx) => {
        const r = await trx
          .selectFrom('tenants')
          .select(['entitlements', 'status'])
          .where('id', '=', tenantId)
          .executeTakeFirst();
        return r
          ? {
              entitlements: effectiveEntitlements(r.entitlements),
              status: TenantStatus.parse(r.status),
            }
          : DEFAULT_ACCESS;
      });
    },
  };
}
