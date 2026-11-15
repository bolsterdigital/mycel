import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITLEMENTS } from '../entitlements/model.js';
import { UseCaseError } from '../errors.js';
import { planAdminRestore, unknownOperator, type RestoreMember } from './erasure.js';

const member = (n: number, capabilities: RestoreMember['capabilities']): RestoreMember => ({
  operatorId: `op-${n}`,
  email: `m${n}@example.org`,
  capabilities,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof UseCaseError ? e.code : 'not a UseCaseError';
  }
  return 'no error';
};

describe('admin restore (ADR 035 rule 3)', () => {
  it('is refused on a site that has an admin', () => {
    const members = [member(1, ['tenant:admin']), member(2, ['content:read'])];
    expect(code(() => planAdminRestore(members, 'new@example.org', DEFAULT_ENTITLEMENTS))).toBe(
      'conflict'
    );
  });

  it('adds the capability to a member with that address, keeping what they hold', () => {
    const plan = planAdminRestore(
      [member(1, ['content:write'])],
      'm1@example.org',
      DEFAULT_ENTITLEMENTS
    );
    expect(plan).toEqual({
      kind: 'grant',
      operatorId: 'op-1',
      capabilities: ['content:write', 'tenant:admin'],
    });
  });

  it('invites a new address within operators.max, as tenant.member.invite counts', () => {
    expect(planAdminRestore([], 'new@example.org', DEFAULT_ENTITLEMENTS)).toEqual({
      kind: 'invite',
      capabilities: ['tenant:admin'],
    });
    const full = { ...DEFAULT_ENTITLEMENTS, 'operators.max': 1 };
    expect(code(() => planAdminRestore([member(1, ['content:read'])], 'n@example.org', full))).toBe(
      'limit_exceeded'
    );
    // A member at the limit can still be made admin: no seat is added.
    expect(planAdminRestore([member(1, ['content:read'])], 'm1@example.org', full).kind).toBe(
      'grant'
    );
  });

  it('refuses an unknown operator as not found', () => {
    expect(unknownOperator('x').code).toBe('not_found');
  });
});
