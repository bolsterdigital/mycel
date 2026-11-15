// The two platform operations of ADR 035 rule 3 over Postgres (migration 0054):
// erase an operator account by id, and restore `tenant:admin` on a tenant left without one. Both
// run as mycel_platform, like the rest of platform.ts, for the platform API and the `mycel`
// command line; the rules they share are core's (`operators/erasure.ts`).
//
// Erasure is one transaction. It finds every tenant where the operator holds a membership or an
// active key (a cross-tenant read 0054 grants), takes those tenants' membership locks in id order,
// and then per tenant, inside that tenant's context: deletes the membership, revokes the keys the
// operator made, expires the tenant's archives when a membership went (rule 5), writes one audit
// row and says whether an admin is left. Then the account row goes (address, name, issuer and
// subject, preferences) and the id joins the installation register. Ids in history stay; without
// the account they identify nobody.
//
// The register is what makes this durable (rule 2): `reapplyOperatorErasures` runs the same steps
// for every registered id that a restored backup brought back, and `mycel erasures apply` calls it
// before the tenant registers. A second request for a registered id finds nothing to change and
// changes nothing: no audit row, no new register row.
//
// Rejected: one transaction per tenant (an account half removed would still log in to the tenants
// not yet reached), taking the locks in the order the tenants were found (two erasures could wait
// for each other), and refusing erasure of a tenant's last admin (rule 3: the restore repairs it).

import { sql, type Kysely } from 'kysely';
import {
  ADMIN_RESTORE,
  ambiguousInvitation,
  OPERATOR_ERASE,
  ERASURE_EXPIRES_EXPORTS,
  ERASURE_EXPORT_ERROR,
  OPERATOR_ERASURE_NOTE,
  effectiveEntitlements,
  hashInput,
  normalizeEmail,
  planAdminRestore,
  unknownOperator,
  type Capability,
  type AdminRestoreResult,
  type OperatorErasureResult,
} from '@mycel/core';
import { recordPlatformAudit } from '../audit.js';
import { uuidv7 } from '../infra/ids.js';
import type { Database } from '../infra/schema.js';
import { advisoryLock, asRole } from '../infra/roles.js';
import type { PlatformActor } from '../platform.js';

type Trx = Kysely<Database>;

/** Act on `tenantId`'s rows for the rest of the transaction; the role stays mycel_platform. */
async function inTenant(trx: Trx, tenantId: string): Promise<void> {
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
}

const createdBy = (operatorId: string) =>
  sql<boolean>`created_by @> ${JSON.stringify({ kind: 'operator', operatorId })}::jsonb`;

/** Every tenant where `operatorId` is a member or has an active key, sorted for the locks. */
async function tenantsOf(trx: Trx, operatorId: string): Promise<string[]> {
  const members = await trx
    .selectFrom('tenant_memberships')
    .select('tenant_id')
    .where('operator_id', '=', operatorId)
    .execute();
  const keys = await trx
    .selectFrom('api_keys')
    .select('tenant_id')
    .where('revoked_at', 'is', null)
    .where(createdBy(operatorId))
    .execute();
  return [...new Set([...members, ...keys].map((r) => r.tenant_id))].sort();
}

/** Whether any member of the current tenant holds `tenant:admin`. */
async function hasAdmin(trx: Trx, tenantId: string): Promise<boolean> {
  const r = await trx
    .selectFrom('tenant_memberships')
    .select('operator_id')
    .where('tenant_id', '=', tenantId)
    .where(sql<boolean>`'tenant:admin' = any(capabilities)`)
    .executeTakeFirst();
  return r !== undefined;
}

async function eraseIn(
  trx: Trx,
  operatorId: string,
  by: PlatformActor,
  request: 'erase' | 'reapply'
): Promise<OperatorErasureResult> {
  const account = await trx
    .selectFrom('operators')
    .select('id')
    .where('id', '=', operatorId)
    .executeTakeFirst();
  const registered = await trx
    .selectFrom('operator_erasures')
    .select('operator_id')
    .where('operator_id', '=', operatorId)
    .executeTakeFirst();
  const found = await tenantsOf(trx, operatorId);
  if (!account && !registered && found.length === 0) throw unknownOperator(operatorId);

  for (const tenantId of found) await advisoryLock(trx, 'members', tenantId);
  // Read again under the locks: an invitation committed in between is a membership too.
  const tenantIds = await tenantsOf(trx, operatorId);
  const slugs = new Map(
    tenantIds.length
      ? (
          await trx
            .selectFrom('tenants')
            .select(['id', 'slug'])
            .where('id', 'in', tenantIds)
            .execute()
        ).map((t) => [t.id, t.slug] as const)
      : []
  );
  const now = new Date();
  const tenants: OperatorErasureResult['tenants'] = [];
  for (const tenantId of tenantIds) {
    if (!found.includes(tenantId)) await advisoryLock(trx, 'members', tenantId);
    await inTenant(trx, tenantId);
    const membership =
      (
        await trx
          .deleteFrom('tenant_memberships')
          .where('tenant_id', '=', tenantId)
          .where('operator_id', '=', operatorId)
          .executeTakeFirst()
      ).numDeletedRows > 0n;
    const revokedKeys = Number(
      (
        await trx
          .updateTable('api_keys')
          .set({ revoked_at: now })
          .where('tenant_id', '=', tenantId)
          .where('revoked_at', 'is', null)
          .where(createdBy(operatorId))
          .executeTakeFirst()
      ).numUpdatedRows
    );
    const expiredExports = membership
      ? Number(
          (
            await trx
              .updateTable('tenant_exports')
              .set({ status: 'expired', error: ERASURE_EXPORT_ERROR, expires_at: now })
              .where('tenant_id', '=', tenantId)
              .where('status', 'in', [...ERASURE_EXPIRES_EXPORTS])
              .executeTakeFirst()
          ).numUpdatedRows
        )
      : 0;
    // Rule 3, tenant trace: the erased operator only as an id, the revoked keys counted.
    await recordPlatformAudit(trx, {
      id: uuidv7(),
      tenantId,
      occurredAt: now,
      actorKind: 'platform',
      actorId: by.actorId,
      operation: OPERATOR_ERASE,
      effect: 'erase',
      inputHash: await hashInput(by.hasher, { operatorId, request, revokedKeys }),
      result: 'ok',
      requestId: by.requestId ?? null,
      subjectId: operatorId,
    });
    tenants.push({
      tenantId,
      slug: slugs.get(tenantId) ?? tenantId,
      membership,
      revokedKeys,
      expiredExports,
      withoutAdmin: !(await hasAdmin(trx, tenantId)),
    });
  }
  if (account) await trx.deleteFrom('operators').where('id', '=', operatorId).execute();
  if (!registered)
    await trx
      .insertInto('operator_erasures')
      .values({ operator_id: operatorId })
      .onConflict((oc) => oc.column('operator_id').doNothing())
      .execute();
  return {
    operatorId,
    alreadyRegistered: registered !== undefined,
    changed: account !== undefined || tenants.length > 0,
    tenants,
    note: OPERATOR_ERASURE_NOTE,
  };
}

/**
 * `platform.operator.erase` (ADR 035 rules 1 to 3): the account, every membership and every key
 * of `operatorId` on every tenant, in one transaction; the id joins the register. Refused as a
 * whole for an id that is neither an account, a member, a key's maker nor registered.
 */
export function eraseOperator(
  db: Kysely<Database>,
  operatorId: string,
  by: PlatformActor
): Promise<OperatorErasureResult> {
  return asRole(db, 'mycel_platform', (trx) => eraseIn(trx, operatorId, by, 'erase'));
}

/**
 * Rule 2 after a restore: every registered operator that the restored database still holds
 * (an account, a membership or an active key) is erased again, each in its own transaction.
 * Returns the results that changed something; a settled register changes nothing.
 */
export async function reapplyOperatorErasures(
  db: Kysely<Database>,
  by: PlatformActor
): Promise<OperatorErasureResult[]> {
  const pending = await asRole(db, 'mycel_platform', async (trx) => {
    const { rows } = await sql<{ id: string }>`
      select r.operator_id as id from operator_erasures r
      where exists (select 1 from operators o where o.id = r.operator_id)
         or exists (select 1 from tenant_memberships m where m.operator_id = r.operator_id)
         or exists (select 1 from api_keys k
                    where k.revoked_at is null
                      and k.created_by @> jsonb_build_object('kind', 'operator', 'operatorId', r.operator_id::text))
      order by r.operator_id`.execute(trx);
    return rows.map((r) => r.id);
  });
  const results: OperatorErasureResult[] = [];
  for (const id of pending)
    results.push(await asRole(db, 'mycel_platform', (trx) => eraseIn(trx, id, by, 'reapply')));
  return results;
}

/** The registered operator ids, for an import that must not bring one back (rule 5). */
export async function erasedOperatorIds(trx: Trx): Promise<Set<string>> {
  return new Set(
    (await trx.selectFrom('operator_erasures').select('operator_id').execute()).map(
      (r) => r.operator_id
    )
  );
}

/**
 * `platform.tenant.admin_restore` (ADR 035 rule 3, Jaap 2026-11-13): give `email` `tenant:admin`
 * on a tenant where no member holds it, through the invitation path of `tenant.member.invite`,
 * checked under the tenant's membership lock and audited in that tenant. Refused on a tenant that
 * has an admin. Null for an unknown tenant.
 */
export function restoreTenantAdmin(
  db: Kysely<Database>,
  tenantId: string,
  email: string,
  by: PlatformActor
): Promise<AdminRestoreResult | null> {
  const address = normalizeEmail(email);
  return asRole(db, 'mycel_platform', async (trx) => {
    const tenant = await trx
      .selectFrom('tenants')
      .select(['id', 'entitlements'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant) return null;
    await advisoryLock(trx, 'members', tenantId);
    await inTenant(trx, tenantId);
    const members = (
      await trx
        .selectFrom('tenant_memberships as m')
        .innerJoin('operators as o', 'o.id', 'm.operator_id')
        .select(['m.operator_id', 'o.email', 'm.capabilities'])
        .where('m.tenant_id', '=', tenantId)
        .execute()
    ).map((m) => ({
      operatorId: m.operator_id,
      email: m.email,
      capabilities: m.capabilities as Capability[],
    }));
    const plan = planAdminRestore(members, address, effectiveEntitlements(tenant.entitlements));
    let operatorId: string;
    if (plan.kind === 'grant') {
      operatorId = plan.operatorId;
      await trx
        .updateTable('tenant_memberships')
        .set({ capabilities: plan.capabilities })
        .where('tenant_id', '=', tenantId)
        .where('operator_id', '=', operatorId)
        .execute();
    } else {
      const { rows } = await sql<{ id: string | null }>`
        select operator_for_invite(${address}, ${uuidv7()}::uuid) as id`.execute(trx);
      const id = rows[0]?.id;
      if (!id) throw ambiguousInvitation();
      operatorId = id;
      await trx
        .insertInto('tenant_memberships')
        .values({
          tenant_id: tenantId,
          operator_id: operatorId,
          capabilities: plan.capabilities,
          created_at: new Date(),
        })
        .execute();
    }
    await recordPlatformAudit(trx, {
      id: uuidv7(),
      tenantId,
      occurredAt: new Date(),
      actorKind: 'platform',
      actorId: by.actorId,
      operation: ADMIN_RESTORE,
      effect: null,
      inputHash: await hashInput(by.hasher, { tenantId, email: address }),
      result: 'ok',
      requestId: by.requestId ?? null,
      subjectId: operatorId,
    });
    return { tenantId, operatorId, kind: plan.kind, capabilities: plan.capabilities };
  });
}
