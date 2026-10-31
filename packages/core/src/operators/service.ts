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
//
// Who acts is read again under that lock (TODO #20a). The principal is loaded at the start of a
// request, outside the tenant transaction; a removal or demotion committed in between would
// otherwise let a former admin make a key or change members with the rights they just lost.
// Every write here takes the lock first and then acts with the capabilities the actor holds now,
// so a key is either committed before the change (and revoked by it) or refused. Rejected: a
// database guard on `api_keys`, which repeats `covers` in SQL and still needs the same lock;
// `serializable` transactions, which make every front handle retries.

import { z } from 'zod';
import { requireEntitled, withinLimit } from '../entitlements/guards.js';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import type { Capability } from '../principal.js';
import { defineUseCase } from '../registry.js';
import {
  ApiKeyView,
  Capabilities,
  Email,
  KeyCapabilities,
  Member,
  MemberView,
  generateApiKey,
  withRole,
} from './model.js';
import './ports.js';
import { exampleId } from '../util/ids.js';

const OperatorId = z.string().guid();

/** The capabilities `held` grants, read the way `can` reads them. */
const covers = (held: readonly Capability[], wanted: readonly Capability[]) =>
  held.includes('tenant:admin') || wanted.every((c) => held.includes(c));

async function requireMember(ctx: TransactionContext, operatorId: string): Promise<Member> {
  const member = await ctx.members.get(operatorId);
  if (!member) throw notFound('member', 'that operator id');
  return member;
}

/**
 * Take the membership lock and return the capabilities the actor holds now. An operator is read
 * again under the lock; background work has no membership and acts with its principal. An API
 * key or agent never holds `tenant:admin`, so reaching here with one is refused, not let through.
 */
async function lockAsCurrentActor(ctx: TransactionContext): Promise<readonly Capability[]> {
  await ctx.members.lock();
  const { actor } = ctx.principal;
  if (actor.kind === 'system') return ctx.principal.capabilities;
  if (actor.kind !== 'operator')
    throw new UseCaseError('forbidden', `${actor.kind} cannot manage members or keys`);
  const current = await ctx.members.get(actor.operatorId);
  if (!current) throw new UseCaseError('forbidden', 'stale_actor: you are no longer a member');
  if (!current.capabilities.includes('tenant:admin'))
    throw new UseCaseError('forbidden', 'stale_actor: you no longer hold tenant:admin');
  return current.capabilities;
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
  name: 'tenant.member.list',
  kind: 'query',
  description: 'List the operators who are members of this site, with their capabilities.',
  requires: 'tenant:admin',
  // Strict: an input without fields still refuses what it does not know.
  input: z.object({}).strict(),
  output: z.object({ members: z.array(MemberView) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return { members: (await ctx.members.list()).map(withRole) };
  },
});

export const inviteMember = defineUseCase({
  name: 'tenant.member.invite',
  kind: 'command',
  description:
    'Give an e-mail address capabilities on this site; the person gets access by logging in with that verified address.',
  requires: 'tenant:admin',
  consumes: 'operators.max',
  input: z.object({ email: Email, capabilities: Capabilities }),
  output: MemberView,
  examples: [{ input: { email: 'editor@example.org', capabilities: ['content:write'] } }],
  async handler(ctx, { email, capabilities }) {
    await lockAsCurrentActor(ctx);
    if (await ctx.members.findByEmail(email))
      throw new UseCaseError('conflict', 'that address is already a member of this site');
    // Under the lock, so two invitations at once cannot both take the last seat.
    withinLimit(ctx, 'operators.max', await ctx.usage.operators());
    const target = await ctx.operators.forInvite(email, ctx.ids.next());
    if (target === 'ambiguous')
      throw new UseCaseError(
        'conflict',
        'several accounts log in with that address; it cannot be invited by address'
      );
    if (await ctx.members.get(target.id))
      throw new UseCaseError('conflict', 'that operator is already a member of this site');
    await ctx.members.insert(target.id, capabilities, ctx.clock.now());
    return withRole(await requireMember(ctx, target.id));
  },
});

export const updateMember = defineUseCase({
  name: 'tenant.member.update',
  kind: 'command',
  description:
    'Replace the capabilities of a member; their API keys that exceed the new capabilities are revoked.',
  requires: 'tenant:admin',
  input: z.object({ operatorId: OperatorId, capabilities: Capabilities }),
  output: MemberView.extend({ revokedKeys: z.number().int() }),
  examples: [
    {
      input: {
        operatorId: exampleId(0x1),
        capabilities: ['content:read'],
      },
    },
  ],
  async handler(ctx, { operatorId, capabilities }) {
    await lockAsCurrentActor(ctx);
    const member = await requireMember(ctx, operatorId);
    if (member.capabilities.includes('tenant:admin') && !capabilities.includes('tenant:admin'))
      await ensureAdminRemains(ctx, operatorId);
    await ctx.members.update(operatorId, capabilities);
    const revokedKeys = await revokeKeysBeyond(ctx, operatorId, capabilities);
    return { ...withRole(await requireMember(ctx, operatorId)), revokedKeys };
  },
});

export const removeMember = defineUseCase({
  name: 'tenant.member.remove',
  kind: 'command',
  description: 'Remove a member from this site and revoke the API keys they created.',
  requires: 'tenant:admin',
  input: z.object({ operatorId: OperatorId }),
  output: z.object({ operatorId: OperatorId, revokedKeys: z.number().int() }),
  examples: [{ input: { operatorId: exampleId(0x1) } }],
  async handler(ctx, { operatorId }) {
    await lockAsCurrentActor(ctx);
    const member = await requireMember(ctx, operatorId);
    if (member.capabilities.includes('tenant:admin')) await ensureAdminRemains(ctx, operatorId);
    await ctx.members.remove(operatorId);
    return { operatorId, revokedKeys: await revokeKeysBeyond(ctx, operatorId, []) };
  },
});

export const listKeys = defineUseCase({
  name: 'tenant.key.list',
  kind: 'query',
  description: 'List the API keys of this site, revoked ones included; never the token itself.',
  requires: 'tenant:admin',
  // Strict: an input without fields still refuses what it does not know.
  input: z.object({}).strict(),
  output: z.object({ keys: z.array(ApiKeyView) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return { keys: (await ctx.apiKeys.list()).map(withRole) };
  },
});

export const createKey = defineUseCase({
  name: 'tenant.key.create',
  kind: 'command',
  description:
    'Create an API key with a subset of your capabilities (never tenant:admin); the token is returned once and never again.',
  requires: 'tenant:admin',
  // Keys are a switch (`api_keys`), not a counted limit.
  consumes: null,
  input: z.object({ name: z.string().trim().min(1).max(100), capabilities: KeyCapabilities }),
  output: z.object({ id: z.string().guid(), token: z.string(), prefix: z.string() }),
  examples: [{ input: { name: 'Newsletter sync', capabilities: ['supporters:read'] } }],
  async handler(ctx, { name, capabilities }) {
    requireEntitled(ctx.principal, 'api_keys');
    // Before the insert, so a concurrent removal or demotion either sees this key or refuses it.
    const held = await lockAsCurrentActor(ctx);
    const beyond = capabilities.filter((c) => !covers(held, [c]));
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
  name: 'tenant.key.revoke',
  kind: 'command',
  description: 'Revoke an API key; it stops working on its next request and stays listed.',
  requires: 'tenant:admin',
  input: z.object({ id: z.string().guid() }),
  output: z.object({ id: z.string().guid() }),
  examples: [{ input: { id: exampleId(0x1) } }],
  async handler(ctx, { id }) {
    if (!(await ctx.apiKeys.revoke(id, ctx.clock.now()))) throw notFound('active API key');
    return { id };
  },
});
