import { beforeEach, describe, expect, it } from 'vitest';
import {
  Invoker,
  TOKEN_PATTERN,
  agentPrincipalFor,
  apiKeyPrincipal,
  buildRegistry,
  hashApiKey,
  operatorPrincipal,
  systemPrincipal,
  useCases,
  type Principal,
  type UnitOfWork,
} from '../index.js';
import {
  FakeClock,
  MemoryIdentityStore,
  MemoryTenants,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
  probeTenant,
} from '../testing/index.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const ISSUER = 'https://idp.example';

describe('members and keys', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let identity: MemoryIdentityStore;
  let invoker: Invoker;
  const system = systemPrincipal(TENANT, 'test');

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    identity = new MemoryIdentityStore(
      uow.store,
      new MemoryTenants([probeTenant(TENANT), { ...probeTenant(OTHER), slug: 'other' }]),
      clock,
      uow.ids
    );
    invoker = new Invoker(buildRegistry(), uow);
  });

  /** Invite, then log in with a verified address: the operator's admin principal. */
  async function loggedIn(email: string, caps: Principal['capabilities'] = ['tenant:admin']) {
    await invoker.run(useCases.inviteMember, system, { email, capabilities: caps });
    const op = await identity.login({
      issuer: ISSUER,
      subject: `sub-${email}`,
      email,
      emailVerified: true,
    });
    const principal = await operatorPrincipal(
      identity,
      { operatorId: op.id, email: op.email },
      TENANT
    );
    return { op, principal: principal! };
  }

  describe('invite', () => {
    it('creates a pending member, normalising the address', async () => {
      const m = await invoker.run(useCases.inviteMember, system, {
        email: '  Editor@Example.ORG ',
        capabilities: ['content:write'],
      });
      expect(m).toMatchObject({ email: 'editor@example.org', pending: true, name: null });
      expect((await invoker.run(useCases.listMembers, system, {})).members).toHaveLength(1);
    });

    it('reuses the pending operator across tenants', async () => {
      const a = await invoker.run(useCases.inviteMember, system, {
        email: 'x@example.org',
        capabilities: ['content:read'],
      });
      const b = await invoker.run(useCases.inviteMember, systemPrincipal(OTHER, 'test'), {
        email: 'x@example.org',
        capabilities: ['content:read'],
      });
      expect(b.operatorId).toBe(a.operatorId);
      expect(uow.store.operators.size).toBe(1);
    });

    it('goes to the operator who logged in with that verified address', async () => {
      const op = await identity.login({
        issuer: ISSUER,
        subject: 's1',
        email: 'known@example.org',
        emailVerified: true,
        name: 'Known',
      });
      const m = await invoker.run(useCases.inviteMember, system, {
        email: 'known@example.org',
        capabilities: ['content:read'],
      });
      expect(m).toMatchObject({ operatorId: op.id, pending: false, name: 'Known' });
    });

    it('never goes to an operator whose address is unverified', async () => {
      const op = await identity.login({
        issuer: ISSUER,
        subject: 's1',
        email: 'claimed@example.org',
        emailVerified: false,
      });
      const m = await invoker.run(useCases.inviteMember, system, {
        email: 'claimed@example.org',
        capabilities: ['content:read'],
      });
      expect(m.operatorId).not.toBe(op.id);
      expect(m.pending).toBe(true);
    });

    it('refuses an address several verified operators share', async () => {
      for (const subject of ['s1', 's2'])
        await identity.login({
          issuer: ISSUER,
          subject,
          email: 'shared@example.org',
          emailVerified: true,
        });
      await expectCode(
        invoker.run(useCases.inviteMember, system, {
          email: 'shared@example.org',
          capabilities: ['content:read'],
        }),
        'conflict'
      );
    });

    it('refuses an existing member with conflict', async () => {
      const input = { email: 'x@example.org', capabilities: ['content:read' as const] };
      await invoker.run(useCases.inviteMember, system, input);
      await expectCode(invoker.run(useCases.inviteMember, system, input), 'conflict');
    });

    it('rejects an empty or repeated capability list', async () => {
      for (const capabilities of [[], ['content:read', 'content:read']])
        await expectCode(
          invoker.run(useCases.inviteMember, system, {
            email: 'x@example.org',
            capabilities: capabilities as never,
          }),
          'invalid_input'
        );
    });
  });

  describe('login', () => {
    it('claims the pending invitation only with a verified address', async () => {
      const invited = await invoker.run(useCases.inviteMember, system, {
        email: 'new@example.org',
        capabilities: ['content:write'],
      });
      const unverified = await identity.login({
        issuer: ISSUER,
        subject: 'a',
        email: 'new@example.org',
        emailVerified: false,
      });
      expect(unverified.id).not.toBe(invited.operatorId);
      expect(await identity.membershipsOf(unverified.id)).toEqual([]);

      const verified = await identity.login({
        issuer: ISSUER,
        subject: 'b',
        email: 'NEW@example.org',
        emailVerified: true,
        name: 'New',
      });
      expect(verified.id).toBe(invited.operatorId);
      expect(await identity.membershipsOf(verified.id)).toEqual([
        { tenantId: TENANT, slug: 'probe', name: 'Probe', capabilities: ['content:write'] },
      ]);
    });

    it('keys on (issuer, subject): a changed address follows the operator, its proof does not', async () => {
      const first = await identity.login({
        issuer: ISSUER,
        subject: 's',
        email: 'old@example.org',
        emailVerified: true,
      });
      clock.advance(1000);
      const moved = await identity.login({
        issuer: ISSUER,
        subject: 's',
        email: 'new@example.org',
        emailVerified: false,
      });
      expect(moved.id).toBe(first.id);
      expect(moved.email).toBe('new@example.org');
      expect(moved.emailVerifiedAt).toBeNull();

      const reverified = await identity.login({
        issuer: ISSUER,
        subject: 's',
        email: 'new@example.org',
        emailVerified: true,
      });
      expect(reverified.emailVerifiedAt).toBe(clock.now().toISOString());
      // Same subject at another issuer is another person.
      const other = await identity.login({
        issuer: 'https://other.example',
        subject: 's',
        email: 'new@example.org',
        emailVerified: true,
      });
      expect(other.id).not.toBe(first.id);
    });

    it('a second verified subject with the same address does not take over a claimed invitation', async () => {
      const { op } = await loggedIn('a@example.org');
      const second = await identity.login({
        issuer: ISSUER,
        subject: 'another',
        email: 'a@example.org',
        emailVerified: true,
      });
      expect(second.id).not.toBe(op.id);
      expect(await identity.membershipsOf(second.id)).toEqual([]);
    });
  });

  describe('the last admin', () => {
    it('cannot remove or demote themselves; another admin can be removed', async () => {
      const { op, principal } = await loggedIn('a@example.org');
      await expectCode(
        invoker.run(useCases.removeMember, principal, { operatorId: op.id }),
        'conflict'
      );
      await expectCode(
        invoker.run(useCases.updateMember, principal, {
          operatorId: op.id,
          capabilities: ['content:write'],
        }),
        'conflict'
      );
      const b = await loggedIn('b@example.org');
      await invoker.run(useCases.removeMember, principal, { operatorId: b.op.id });
      await invoker.run(useCases.updateMember, principal, {
        operatorId: op.id,
        capabilities: ['tenant:admin', 'content:write'],
      });
    });

    it('answers not_found for a non-member', async () => {
      await expectCode(
        invoker.run(useCases.removeMember, system, {
          operatorId: '01900000-0000-7000-8000-0000000000ff',
        }),
        'not_found'
      );
    });
  });

  describe('keys', () => {
    it('creates a token of the documented form, stores only its hash, and lists without it', async () => {
      const { principal } = await loggedIn('a@example.org');
      const created = await invoker.run(useCases.createKey, principal, {
        name: 'Sync',
        capabilities: ['supporters:read'],
      });
      expect(created.token).toMatch(TOKEN_PATTERN);
      expect(created.prefix).toBe(created.token.slice(0, 12));
      const stored = [...uow.store.for(TENANT).apiKeys.values()][0]!;
      expect(stored.keyHash).toBe(await hashApiKey(created.token));
      expect(JSON.stringify(stored)).not.toContain(created.token);

      const { keys } = await invoker.run(useCases.listKeys, principal, {});
      expect(keys).toEqual([
        expect.objectContaining({
          id: created.id,
          prefix: created.prefix,
          capabilities: ['supporters:read'],
          createdBy: principal.actor,
          revokedAt: null,
        }),
      ]);
      expect(JSON.stringify(keys)).not.toContain(created.token);
    });

    it('never gives a key tenant:admin', async () => {
      await expectCode(
        invoker.run(useCases.createKey, system, {
          name: 'Root',
          capabilities: ['tenant:admin'] as never,
        }),
        'invalid_input'
      );
    });

    it('authenticates a key with its own capabilities until it is revoked', async () => {
      const { token, id } = await invoker.run(useCases.createKey, system, {
        name: 'Sync',
        capabilities: ['content:read', 'forms:read'],
      });
      const auth = await apiKeyPrincipal(identity, `Bearer ${token}`);
      expect(auth?.principal).toEqual(
        principal({
          actor: { kind: 'api-key', keyId: id },
          capabilities: ['content:read', 'forms:read'],
        })
      );
      const agent = await agentPrincipalFor(identity, token, 'session-1');
      expect(agent?.principal.actor).toEqual({ kind: 'agent', sessionId: 'session-1', keyId: id });

      expect(await apiKeyPrincipal(identity, 'Bearer mycel_unknown')).toBeNull();
      expect(await apiKeyPrincipal(identity, token)).toBeNull();
      expect(await apiKeyPrincipal(identity, undefined)).toBeNull();

      await invoker.run(useCases.revokeKey, system, { id });
      expect(await apiKeyPrincipal(identity, `Bearer ${token}`)).toBeNull();
      expect(await agentPrincipalFor(identity, token, 'session-1')).toBeNull();
      await expectCode(invoker.run(useCases.revokeKey, system, { id }), 'not_found');
    });

    it('revokes the keys of a removed member, and those a demotion leaves uncovered', async () => {
      const a = await loggedIn('a@example.org');
      const b = await loggedIn('b@example.org');
      const make = (name: string, capabilities: ('content:read' | 'mailing:send')[]) =>
        invoker.run(useCases.createKey, b.principal, { name, capabilities });
      const narrow = await make('narrow', ['content:read']);
      const wide = await make('wide', ['content:read', 'mailing:send']);
      const bySystem = await invoker.run(useCases.createKey, system, {
        name: 'seed',
        capabilities: ['mailing:send'],
      });

      const demoted = await invoker.run(useCases.updateMember, a.principal, {
        operatorId: b.op.id,
        capabilities: ['content:read'],
      });
      expect(demoted.revokedKeys).toBe(1);
      expect(await apiKeyPrincipal(identity, `Bearer ${wide.token}`)).toBeNull();
      expect(await apiKeyPrincipal(identity, `Bearer ${narrow.token}`)).not.toBeNull();

      const removed = await invoker.run(useCases.removeMember, a.principal, {
        operatorId: b.op.id,
      });
      expect(removed.revokedKeys).toBe(1);
      expect(await apiKeyPrincipal(identity, `Bearer ${narrow.token}`)).toBeNull();
      expect(await apiKeyPrincipal(identity, `Bearer ${bySystem.token}`)).not.toBeNull();
    });
  });

  describe('acting under the membership lock (TODO #20a)', () => {
    it('refuses an operator whose principal predates their removal', async () => {
      const a = await loggedIn('a@example.org');
      const b = await loggedIn('b@example.org');
      await invoker.run(useCases.removeMember, a.principal, { operatorId: b.op.id });
      await expectCode(
        invoker.run(useCases.createKey, b.principal, {
          name: 'stale',
          capabilities: ['content:read'],
        }),
        'forbidden'
      );
      // Nor can they invite themselves back or change another member.
      await expectCode(
        invoker.run(useCases.inviteMember, b.principal, {
          email: 'b@example.org',
          capabilities: ['tenant:admin'],
        }),
        'forbidden'
      );
      await expectCode(
        invoker.run(useCases.updateMember, b.principal, {
          operatorId: a.op.id,
          capabilities: ['content:read'],
        }),
        'forbidden'
      );
      expect(uow.store.for(TENANT).apiKeys.size).toBe(0);
    });

    it('refuses an operator who no longer holds tenant:admin', async () => {
      const a = await loggedIn('a@example.org');
      const b = await loggedIn('b@example.org');
      await invoker.run(useCases.updateMember, a.principal, {
        operatorId: b.op.id,
        capabilities: ['content:write'],
      });
      await expectCode(
        invoker.run(useCases.createKey, b.principal, {
          name: 'stale',
          capabilities: ['content:write'],
        }),
        'forbidden'
      );
      await expectCode(
        invoker.run(useCases.removeMember, b.principal, { operatorId: a.op.id }),
        'forbidden'
      );
    });

    it('lets background work through, and refuses a key that claims tenant:admin', async () => {
      await invoker.run(useCases.createKey, system, {
        name: 'seed',
        capabilities: ['content:read'],
      });
      const forged = principal({
        actor: { kind: 'api-key', keyId: '01900000-0000-7000-8000-0000000000aa' },
      });
      await expectCode(
        invoker.run(useCases.createKey, forged, { name: 'k', capabilities: ['content:read'] }),
        'forbidden'
      );
      await expectCode(
        invoker.run(useCases.inviteMember, forged, {
          email: 'c@example.org',
          capabilities: ['content:read'],
        }),
        'forbidden'
      );
    });

    it('a removal that waits for a key in flight revokes it', async () => {
      const a = await loggedIn('a@example.org');
      const b = await loggedIn('b@example.org');
      // Hold b's key at its insert, after its lock and its re-read of the membership.
      let reached!: () => void;
      const atInsert = new Promise<void>((r) => (reached = r));
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const holding: UnitOfWork = {
        run: (p, fn) =>
          uow.run(p, (ctx) =>
            fn({
              ...ctx,
              apiKeys: {
                ...ctx.apiKeys,
                async insert(key) {
                  reached();
                  await released;
                  await ctx.apiKeys.insert(key);
                },
              },
            })
          ),
      };
      const creating = new Invoker(buildRegistry(), holding).run(useCases.createKey, b.principal, {
        name: 'race',
        capabilities: ['content:write'],
      });
      await atInsert;
      let removedYet = false;
      const removing = invoker
        .run(useCases.removeMember, a.principal, { operatorId: b.op.id })
        .finally(() => (removedYet = true));
      await new Promise((r) => setTimeout(r, 10));
      expect(removedYet).toBe(false);
      release();
      const [key, removed] = await Promise.all([creating, removing]);
      expect(removed.revokedKeys).toBe(1);
      expect(await apiKeyPrincipal(identity, `Bearer ${key.token}`)).toBeNull();
    });
  });

  describe('operator principal', () => {
    it('comes from the membership of the tenant in the URL and nothing else', async () => {
      const { op } = await loggedIn('a@example.org', ['content:write']);
      const who = { operatorId: op.id, email: op.email };
      expect(await operatorPrincipal(identity, who, TENANT)).toEqual(
        principal({
          actor: { kind: 'operator', operatorId: op.id, email: 'a@example.org' },
          capabilities: ['content:write'],
        })
      );
      expect(await operatorPrincipal(identity, who, OTHER)).toBeNull();
    });

    it('is refused the member use cases without tenant:admin', async () => {
      const { principal } = await loggedIn('a@example.org', ['content:write']);
      await expectCode(invoker.run(useCases.listMembers, principal, {}), 'forbidden');
    });
  });
});
