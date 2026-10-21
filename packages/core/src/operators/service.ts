// Members and API keys of one tenant (TODO #7). Every use case needs `tenant:admin`: managing who
// may do what is the one thing an API key or agent can never do (keys never carry that
// capability, see model.ts). All writes of one tenant's memberships take the tenant's membership
// lock first, so two admins acting at once cannot both pass the "an admin remains" check.
//
// What a membership change does to keys (fundamentcheck 2026-10-21): a key is attributed to the
// operator who made it, and they have seen its token. Removing that operator revokes the keys
// they made; reducing their capabilities revokes those keys that now exceed them. Keys made by
// the system (the seed) are never touched. Rejected: leaving such keys alive, which turns every
// departure into a credential that keeps working, and deleting them, which loses attribution
// (ADR 009 rule 9).

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { can, type Capability } from '../principal.js';
import { defineUseCase } from '../registry.js';
import {
  ApiKeySummary,
  Capabilities,
  Email,
  KeyCapabilities,
  Member,
  generateApiKey,
} from './model.js';
import './ports.js';

const OperatorId = z.string().uuid();

/** The capabilities `held` grants, read the way `can` reads them. */
const covers = (held: readonly Capability[], wanted: readonly Capability[]) =>
  held.includes('tenant:admin') || wanted.every((c) => held.includes(c));

async function requireMember(ctx: TransactionContext, operatorId: string): Promise<Member> {
  const member = await ctx.members.get(operatorId);
  if (!member) throw new UseCaseError('not_found', 'no member with that operator id');
  return member;
}

/** Under the lock: refuse a change that would leave the tenant without an admin. */
async function ensureAdminRemains(ctx: TransactionContext, losing: string): Promise<void> {
  const admins = (await ctx.members.list()).filter(
    (m) => m.capabilities.includes('tenant:admin') && m.operatorId !== losing
  );
  if (admins.length === 0)
    throw new UseCaseError('conflict', 'a site needs at least one member with tenant:admin');
}

/** Revoke the keys `operatorId` made that `remaining` no longer covers; returns how many. */
async function revokeKeysBeyond(
  ctx: TransactionContext,
  operatorId: string,
  remaining: readonly Capability[]
): Promise<number> {
  const now = ctx.clock.now();
  let revoked = 0;
  for (const key of await ctx.apiKeys.createdBy(operatorId))
    if (!covers(remaining, key.capabilities) && (await ctx.apiKeys.revoke(key.id, now)))
      revoked += 1;
  return revoked;
}

export const listMembers = defineUseCase({
  name: 'tenant.members.list',
  kind: 'query',
  description: 'List the operators who are members of this site, with their capabilities.',
  requires: 'tenant:admin',
  input: z.object({}),
  output: z.object({ members: z.array(Member) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return { members: await ctx.members.list() };
  },
});

export const inviteMember = defineUseCase({
  name: 'tenant.members.invite',
  kind: 'command',
  description:
    'Give an e-mail address capabilities on this site; the person gets access by logging in with that verified address.',
  requires: 'tenant:admin',
  input: z.object({ email: Email, capabilities: Capabilities }),
  output: Member,
  examples: [{ input: { email: 'editor@example.org', capabilities: ['content:write'] } }],
  async handler(ctx, { email, capabilities }) {
    await ctx.members.lock();
    if (await ctx.members.findByEmail(email))
      throw new UseCaseError('conflict', 'that address is already a member of this site');
    const target = await ctx.operators.forInvite(email, ctx.ids.next());
    if (target === 'ambiguous')
      throw new UseCaseError(
        'conflict',
        'several accounts log in with that address; it cannot be invited by address'
      );
    if (await ctx.members.get(target.id))
      throw new UseCaseError('conflict', 'that operator is already a member of this site');
    await ctx.members.insert(target.id, capabilities, ctx.clock.now());
    return requireMember(ctx, target.id);
  },
});

export const updateMember = defineUseCase({
  name: 'tenant.members.update',
  kind: 'command',
  description:
    'Replace the capabilities of a member; their API keys that exceed the new capabilities are revoked.',
  requires: 'tenant:admin',
  input: z.object({ operatorId: OperatorId, capabilities: Capabilities }),
  output: Member.extend({ revokedKeys: z.number().int() }),
  examples: [
    {
      input: {
        operatorId: '01900000-0000-7000-8000-000000000001',
        capabilities: ['content:read'],
      },
    },
  ],
  async handler(ctx, { operatorId, capabilities }) {
    await ctx.members.lock();
    const member = await requireMember(ctx, operatorId);
    if (member.capabilities.includes('tenant:admin') && !capabilities.includes('tenant:admin'))
      await ensureAdminRemains(ctx, operatorId);
    await ctx.members.update(operatorId, capabilities);
    const revokedKeys = await revokeKeysBeyond(ctx, operatorId, capabilities);
    return { ...(await requireMember(ctx, operatorId)), revokedKeys };
  },
});

export const removeMember = defineUseCase({
  name: 'tenant.members.remove',
  kind: 'command',
  description: 'Remove a member from this site and revoke the API keys they created.',
  requires: 'tenant:admin',
  input: z.object({ operatorId: OperatorId }),
  output: z.object({ operatorId: OperatorId, revokedKeys: z.number().int() }),
  examples: [{ input: { operatorId: '01900000-0000-7000-8000-000000000001' } }],
  async handler(ctx, { operatorId }) {
    await ctx.members.lock();
    const member = await requireMember(ctx, operatorId);
    if (member.capabilities.includes('tenant:admin')) await ensureAdminRemains(ctx, operatorId);
    await ctx.members.remove(operatorId);
    return { operatorId, revokedKeys: await revokeKeysBeyond(ctx, operatorId, []) };
  },
});

export const listKeys = defineUseCase({
  name: 'tenant.keys.list',
  kind: 'query',
  description: 'List the API keys of this site, revoked ones included; never the token itself.',
  requires: 'tenant:admin',
  input: z.object({}),
  output: z.object({ keys: z.array(ApiKeySummary) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return { keys: await ctx.apiKeys.list() };
  },
});

export const createKey = defineUseCase({
  name: 'tenant.keys.create',
  kind: 'command',
  description:
    'Create an API key with a subset of your capabilities (never tenant:admin); the token is returned once and never again.',
  requires: 'tenant:admin',
  input: z.object({ name: z.string().trim().min(1).max(100), capabilities: KeyCapabilities }),
  output: z.object({ id: z.string().uuid(), token: z.string(), prefix: z.string() }),
  examples: [{ input: { name: 'Newsletter sync', capabilities: ['supporters:read'] } }],
  async handler(ctx, { name, capabilities }) {
    const beyond = capabilities.filter((c) => !can(ctx.principal, c));
    if (beyond.length)
      throw new UseCaseError('forbidden', `a key cannot get ${beyond.join(', ')}: you lack it`);
    const id = ctx.ids.next();
    const { token, prefix, hash } = await generateApiKey();
    await ctx.apiKeys.insert({
      id,
      name,
      prefix,
      keyHash: hash,
      capabilities,
      createdBy: ctx.principal.actor,
      createdAt: ctx.clock.now(),
    });
    return { id, token, prefix };
  },
});

export const revokeKey = defineUseCase({
  name: 'tenant.keys.revoke',
  kind: 'command',
  description: 'Revoke an API key; it stops working on its next request and stays listed.',
  requires: 'tenant:admin',
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ id: z.string().uuid() }),
  examples: [{ input: { id: '01900000-0000-7000-8000-000000000001' } }],
  async handler(ctx, { id }) {
    if (!(await ctx.apiKeys.revoke(id, ctx.clock.now())))
      throw new UseCaseError('not_found', 'no active API key with that id');
    return { id };
  },
});
