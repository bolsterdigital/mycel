// What the installation does to an operator account and to a tenant left without an admin (ADR
// 035 rules 1 to 3). Both are platform operations, not use cases: the account is
// installation data that may serve several tenants, and no tenant may remove another tenant's
// member. packages/db/src/operators/erasure.ts runs them as mycel_platform for the platform API and
// the `mycel` command line; the rules they share live here, so both fronts refuse and accept the
// same things.
//
// Rejected: a tenant use case `tenant.operator.erase` and an admin restore through
// `tenant.member.invite` with a constructed admin principal (both in ADR 035's rejected list), and
// these rules in the adapter beside the SQL (the memory store and a second adapter would have to
// repeat them).

import { z } from 'zod';
import { withinLimit } from '../entitlements/guards.js';
import type { Entitlements } from '../entitlements/model.js';
import { notFound, UseCaseError } from '../errors.js';
import type { Capability } from '../principal.js';
import { Email } from './model.js';

/** The audit operations of the two platform operations; the storage catalog names them as routes. */
export const OPERATOR_ERASE = 'platform.operator.erase';
export const ADMIN_RESTORE = 'platform.tenant.admin_restore';
export const OPERATOR_PLATFORM_OPERATIONS: readonly string[] = [OPERATOR_ERASE, ADMIN_RESTORE];

export const OperatorErasureInput = z.object({ operatorId: z.string().guid() }).strict();
export const AdminRestoreInput = z.object({ email: Email }).strict();

/** What erasing one operator did, per tenant where they held a membership or made a key. */
export interface OperatorErasureResult {
  operatorId: string;
  /** True when the id was already in the register; a request that found nothing left is a no-op. */
  alreadyRegistered: boolean;
  /** Whether this request changed anything: the account, a membership or a key. */
  changed: boolean;
  tenants: {
    tenantId: string;
    slug: string;
    /** The membership on this tenant was removed. */
    membership: boolean;
    revokedKeys: number;
    /** Archives this erasure expired on this tenant (ADR 035 rule 5). */
    expiredExports: number;
    /** No member of this tenant holds `tenant:admin` any more; repair with the admin restore. */
    withoutAdmin: boolean;
  }[];
  /** Rule 6, said in every result rather than claiming "all erased". */
  note: string;
}

export const OPERATOR_ERASURE_NOTE =
  'names in free text (prose, API-key labels, connection purposes, pattern names) are not found ' +
  'from an operator id; the tenant edits current text through ordinary use cases';

/**
 * The refusal of rule 1: an id found neither as an account, a membership, a key nor in the
 * register is refused as a whole, so a typo never reads as a completed erasure.
 */
export function unknownOperator(operatorId: string): UseCaseError {
  return notFound('operator', `id ${operatorId} on this installation or in its erasure register`);
}

/** An address that several verified accounts log in with cannot be invited by address. */
export const ambiguousInvitation = (): UseCaseError =>
  new UseCaseError(
    'conflict',
    'several accounts log in with that address; it cannot be invited by address'
  );

export interface AdminRestoreResult {
  tenantId: string;
  operatorId: string;
  /** `grant`: an existing member got `tenant:admin`; `invite`: a pending invitation was made. */
  kind: 'grant' | 'invite';
  capabilities: Capability[];
}

/** A member of the tenant as the admin restore reads it under the membership lock. */
export interface RestoreMember {
  operatorId: string;
  email: string;
  capabilities: readonly Capability[];
}

/**
 * What the admin restore does on a tenant (ADR 035 rule 3, Jaap 2026-11-13): only while no member
 * holds `tenant:admin`, checked by the caller under the tenant's membership lock; then the member
 * with that address gets the capability added, or the address is invited as a pending
 * `tenant:admin`, within `operators.max` as `tenant.member.invite` counts it. Refused otherwise:
 * it repairs a tenant without an admin and is no way to add an admin beside existing ones.
 */
export function planAdminRestore(
  members: readonly RestoreMember[],
  email: string,
  entitlements: Entitlements
):
  | { kind: 'grant'; operatorId: string; capabilities: Capability[] }
  | { kind: 'invite'; capabilities: Capability[] } {
  if (members.some((m) => m.capabilities.includes('tenant:admin')))
    throw new UseCaseError(
      'conflict',
      'this site has a member with tenant:admin; the platform restores an admin only on a site without one'
    );
  const existing = members.find((m) => m.email === email);
  if (existing)
    return {
      kind: 'grant',
      operatorId: existing.operatorId,
      capabilities: [...new Set<Capability>([...existing.capabilities, 'tenant:admin'])],
    };
  withinLimit({ principal: { entitlements } }, 'operators.max', members.length);
  return { kind: 'invite', capabilities: ['tenant:admin'] };
}
