// Tiers, grants and the access policy in memory (ADR 016 rules 2 and 3, ADR 019 rules 2 and 4).
// Tenant isolation under RLS, the concurrent fold, export and erasure against Postgres are in
// packages/db/src/access.test.ts.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { systemPrincipal } from '../../principal.js';
import { SupporterEvent, type SupporterEventType } from '../../supporters/events.js';
import { rebuildProjection } from '../../supporters/model.js';
import { tombstoneEmail } from '../../supporters/erasure.js';
import { ingest } from '../../supporters/service.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { hasAccess, readerOf, type ReaderAccess } from './model.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const TIER_A = '01900000-0000-7000-8000-0000000000a1';
const TIER_B = '01900000-0000-7000-8000-0000000000b2';

const event = (
  id: string,
  type: SupporterEventType,
  minute: number,
  props: Record<string, unknown> = {},
  email = 'reader@example.org'
) =>
  SupporterEvent.parse({
    schema: 'wings.supporter-event.v1',
    id,
    type,
    email,
    occurred_at: new Date(Date.UTC(2026, 10, 16, 12, minute)).toISOString(),
    source: 'test',
    source_site: 'urn:mycel:test',
    source_ref: id,
    props,
  });

const setup = () => {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'test');
  const supporter = async (email = 'reader@example.org', tenant = admin) => {
    await uow.run(tenant, (ctx) =>
      ingest(ctx, event(`seen-${email}`, 'newsletter.subscribed', 0, { list: 'news' }, email))
    );
    return invoker.run(useCases.getSupporter, tenant, { email });
  };
  const tier = (slug: string, tenant = admin) =>
    invoker.run(useCases.createAccessTier, tenant, { slug, name: { nl: slug, en: slug } });
  return { clock, uow, invoker, admin, supporter, tier };
};

describe('hasAccess', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  const grant = (tierId: string, until: string | null = null) => ({
    tierId,
    kind: 'comp' as const,
    grantedAt: '2026-11-01T00:00:00.000Z',
    until,
  });
  const reader = (...grants: ReturnType<typeof grant>[]): ReaderAccess => ({
    supporterId: TIER_A,
    grants,
  });
  const item = (level: 'public' | 'members' | 'tier', tierIds?: string[]) => ({
    access: { level, ...(tierIds ? { tierIds } : {}) },
  });

  it('opens public to everyone and members to any reader', () => {
    expect(hasAccess(null, item('public'), now)).toBe(true);
    expect(hasAccess(null, item('members'), now)).toBe(false);
    expect(hasAccess(reader(), item('members'), now)).toBe(true);
  });

  it('opens a tier item only with a standing grant on one of its tiers', () => {
    expect(hasAccess(null, item('tier', [TIER_A]), now)).toBe(false);
    expect(hasAccess(reader(), item('tier', [TIER_A]), now)).toBe(false);
    expect(hasAccess(reader(grant(TIER_B)), item('tier', [TIER_A]), now)).toBe(false);
    expect(hasAccess(reader(grant(TIER_B)), item('tier', [TIER_A, TIER_B]), now)).toBe(true);
    expect(hasAccess(reader(grant(TIER_A)), item('tier', [TIER_A]), now)).toBe(true);
  });

  it('ends at until itself: the end is exclusive (ADR 019 rule 4)', () => {
    const until = '2026-11-16T12:00:00.000Z';
    const holder = reader(grant(TIER_A, until));
    const target = item('tier', [TIER_A]);
    expect(hasAccess(holder, target, new Date(Date.parse(until) - 1))).toBe(true);
    expect(hasAccess(holder, target, new Date(until))).toBe(false);
    expect(hasAccess(holder, target, new Date(Date.parse(until) + 1))).toBe(false);
  });

  it('fails closed on what it cannot read', () => {
    expect(hasAccess(reader(grant(TIER_A)), item('tier'), now)).toBe(false);
    expect(hasAccess(reader(grant(TIER_A)), item('tier', []), now)).toBe(false);
    expect(hasAccess(reader(grant(TIER_A, 'never')), item('tier', [TIER_A]), now)).toBe(false);
    expect(
      hasAccess(
        reader(grant(TIER_A)),
        { access: { level: 'vip' as never, tierIds: [TIER_A] } },
        now
      )
    ).toBe(false);
  });

  it('makes an erased supporter nobody', () => {
    const projection = rebuildProjection([
      { ...event('e1', 'newsletter.subscribed', 0), supporter_id: TIER_B },
    ])!;
    expect(readerOf(projection)).toEqual({ supporterId: projection.id, grants: [] });
    expect(readerOf({ ...projection, email: tombstoneEmail(projection.id) })).toBeNull();
    expect(readerOf(null)).toBeNull();
  });
});

describe('grant fold', () => {
  const ID = '01900000-0000-7000-8000-00000000cccc';
  const of = (events: SupporterEvent[]) =>
    rebuildProjection(events.map((e) => ({ ...e, supporter_id: ID })))!.grants;
  const granted = (id: string, minute: number, tierId: string, extra = {}) =>
    event(id, 'access.granted', minute, { tier_id: tierId, kind: 'comp', reason: 'r', ...extra });
  const revoked = (id: string, minute: number, tierId: string) =>
    event(id, 'access.revoked', minute, { tier_id: tierId, reason: 'r' });

  it('keeps one standing grant per tier; a later grant replaces, a revoke removes', () => {
    const grants = of([
      granted('g1', 1, TIER_A),
      granted('g2', 2, TIER_B, { kind: 'gift', until: '2027-01-01T01:00:00+01:00' }),
      granted('g3', 3, TIER_A, { until: '2026-12-01T00:00:00.000Z' }),
    ]);
    expect(grants).toEqual([
      {
        tierId: TIER_A,
        kind: 'comp',
        grantedAt: '2026-11-16T12:03:00.000Z',
        until: '2026-12-01T00:00:00.000Z',
      },
      {
        tierId: TIER_B,
        kind: 'gift',
        grantedAt: '2026-11-16T12:02:00.000Z',
        until: '2027-01-01T00:00:00.000Z',
      },
    ]);
    expect(of([granted('g1', 1, TIER_A), revoked('r1', 2, TIER_A)])).toEqual([]);
  });

  it('gives the same grants for every arrival order (ADR 019 rule 2)', () => {
    const lateGrant = [revoked('r1', 5, TIER_A), granted('g1', 1, TIER_A)];
    expect(of(lateGrant)).toEqual([]);
    const regrant = [granted('g2', 9, TIER_A), revoked('r1', 5, TIER_A), granted('g1', 1, TIER_A)];
    expect(of(regrant).map((g) => g.grantedAt)).toEqual(['2026-11-16T12:09:00.000Z']);
  });

  it('reads no grant from an event it cannot read', () => {
    expect(
      of([
        event('g1', 'access.granted', 1, {}),
        event('g2', 'access.granted', 2, { tier_id: 'not-a-uuid', kind: 'comp' }),
        event('g3', 'access.granted', 3, { tier_id: TIER_A, kind: 'bribe' }),
        event('g4', 'access.granted', 4, { tier_id: TIER_A, kind: 'comp', until: 'soon' }),
      ])
    ).toEqual([]);
  });
});

describe('access tiers', () => {
  it('creates, lists and renames a tier; slug and kind stay', async () => {
    const { invoker, admin, clock } = setup();
    const tier = await invoker.run(useCases.createAccessTier, admin, {
      slug: 'leden',
      kind: 'paid',
      name: { nl: 'Leden' },
    });
    expect(tier).toMatchObject({ slug: 'leden', kind: 'paid', order: 0 });
    clock.advance(1000);
    const renamed = await invoker.run(useCases.updateAccessTier, admin, {
      tierId: tier.id,
      baseUpdatedAt: tier.updatedAt,
      name: { nl: 'Vrienden', en: 'Friends' },
      order: 2,
    });
    expect(renamed).toMatchObject({
      id: tier.id,
      slug: 'leden',
      kind: 'paid',
      name: { nl: 'Vrienden', en: 'Friends' },
      order: 2,
    });
    expect(await invoker.run(useCases.getAccessTier, admin, { tierId: tier.id })).toEqual(renamed);
    expect((await invoker.run(useCases.listAccessTiers, admin, {})).tiers).toEqual([renamed]);
    await expect(
      invoker.run(useCases.updateAccessTier, admin, {
        tierId: tier.id,
        baseUpdatedAt: tier.updatedAt,
        name: { nl: 'Te laat' },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(useCases.updateAccessTier, admin, {
        tierId: tier.id,
        baseUpdatedAt: renamed.updatedAt,
        name: { nl: 'X' },
        kind: 'free',
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a taken slug and keeps tenants apart', async () => {
    const { invoker, admin, tier } = setup();
    const mine = await tier('leden');
    await expect(tier('leden')).rejects.toMatchObject({ code: 'conflict' });
    const other = systemPrincipal(OTHER, 'test');
    await expect(
      invoker.run(useCases.getAccessTier, other, { tierId: mine.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await invoker.run(useCases.listAccessTiers, other, {})).tiers).toEqual([]);
    await expect(tier('leden', other)).resolves.toMatchObject({ slug: 'leden' });
    expect((await invoker.run(useCases.listAccessTiers, admin, {})).tiers).toHaveLength(1);
  });

  it('asks content:publish to write a tier and content:read to read one', async () => {
    const { invoker, tier } = setup();
    const writer = principal({ capabilities: ['content:read', 'content:write'] });
    await expect(
      invoker.run(useCases.createAccessTier, writer, { slug: 'x', name: { nl: 'X' } })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const made = await tier('leden');
    await expect(
      invoker.run(useCases.updateAccessTier, writer, {
        tierId: made.id,
        baseUpdatedAt: made.updatedAt,
        name: { nl: 'X' },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(invoker.run(useCases.getAccessTier, writer, { tierId: made.id })).resolves.toEqual(
      made
    );
    const publisher = principal({ capabilities: ['content:publish'] });
    await expect(
      invoker.run(useCases.createAccessTier, publisher, { slug: 'pers', name: { nl: 'Pers' } })
    ).resolves.toMatchObject({ slug: 'pers' });
  });
});

describe('access grants', () => {
  it('grants until a moment, replaces on a second grant and revokes as its own event', async () => {
    const { invoker, admin, clock, supporter, tier, uow } = setup();
    const reader = await supporter();
    const leden = await tier('leden');
    const until = new Date(clock.now().getTime() + 60_000).toISOString();
    clock.advance(1);
    const granted = await invoker.run(useCases.createAccessGrant, admin, {
      supporterId: reader.id,
      tierId: leden.id,
      kind: 'comp',
      reason: 'Persweek',
      until,
    });
    expect(granted.grants).toEqual([
      { tierId: leden.id, kind: 'comp', grantedAt: clock.now().toISOString(), until },
    ]);
    const article = { access: { level: 'tier' as const, tierIds: [leden.id] } };
    expect(hasAccess(readerOf(granted), article, clock.now())).toBe(true);
    expect(hasAccess(readerOf(granted), article, new Date(until))).toBe(false);

    clock.advance(1);
    const gifted = await invoker.run(useCases.createAccessGrant, admin, {
      supporterId: reader.id,
      tierId: leden.id,
      kind: 'gift',
      reason: 'Cadeau',
    });
    expect(gifted.grants).toMatchObject([{ tierId: leden.id, kind: 'gift', until: null }]);

    clock.advance(1);
    const revoked = await invoker.run(useCases.revokeAccessGrant, admin, {
      supporterId: reader.id,
      tierId: leden.id,
      reason: 'Voorbij',
    });
    expect(revoked.grants).toEqual([]);
    expect(hasAccess(readerOf(revoked), article, clock.now())).toBe(false);
    const log = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(reader.id));
    expect(log.map((e) => e.type).sort()).toEqual([
      'access.granted',
      'access.granted',
      'access.revoked',
      'newsletter.subscribed',
    ]);
    expect(revoked).toEqual(rebuildProjection(log));
    // The public projection of a supporter carries no reason.
    expect(JSON.stringify(gifted)).not.toContain('Cadeau');
    await expect(
      invoker.run(useCases.revokeAccessGrant, admin, {
        supporterId: reader.id,
        tierId: leden.id,
        reason: 'Nog eens',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses an unknown tier, another tenant, a past end and an erased supporter', async () => {
    const { invoker, admin, clock, supporter, tier, uow } = setup();
    const reader = await supporter();
    const leden = await tier('leden');
    const other = systemPrincipal(OTHER, 'test');
    const foreignTier = await tier('elders', other);
    const foreignReader = await supporter('elders@example.org', other);
    const grant = (change: Record<string, unknown>, as = admin) =>
      invoker.run(useCases.createAccessGrant, as, {
        supporterId: reader.id,
        tierId: leden.id,
        kind: 'comp',
        reason: 'r',
        ...change,
      });
    await expect(grant({ tierId: TIER_A })).rejects.toMatchObject({ code: 'not_found' });
    await expect(grant({ tierId: foreignTier.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(grant({ supporterId: foreignReader.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(grant({}, other)).rejects.toMatchObject({ code: 'not_found' });
    await expect(grant({ until: clock.now().toISOString() })).rejects.toMatchObject({
      code: 'invalid_input',
    });

    await grant({});
    await invoker.run(useCases.eraseSupporter, admin, { supporterId: reader.id });
    // What the `supporter.erase` handler does on the operator connection.
    await uow.run(admin, (ctx) => ctx.erasures.apply());
    const erased = await uow.run(admin, (ctx) => ctx.supporters.getProjectionById(reader.id));
    expect(erased).toMatchObject({ email: tombstoneEmail(reader.id), grants: [] });
    // The log no longer names a tier, so a re-fold gives no grant back.
    const log = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(reader.id));
    expect(log.every((e) => Object.keys(e.props).length === 0)).toBe(true);
    expect(rebuildProjection(log)!.grants).toEqual([]);
    await expect(grant({})).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never takes a grant from an ingested envelope', async () => {
    const { invoker, admin, supporter, tier, uow } = setup();
    const reader = await supporter();
    const leden = await tier('leden');
    const smuggled = event('smuggled', 'access.granted', 5, { tier_id: leden.id, kind: 'comp' });
    expect(await uow.run(admin, (ctx) => ingest(ctx, smuggled))).toBe(false);
    const after = await invoker.run(useCases.getSupporter, admin, { email: reader.email });
    expect(after.grants).toEqual([]);
    expect(await uow.run(admin, (ctx) => ctx.supporters.eventsFor(reader.id))).toHaveLength(1);
  });

  it('is an admin decision, for every front alike', async () => {
    const { invoker, supporter, tier } = setup();
    const reader = await supporter();
    const leden = await tier('leden');
    const editor = principal({
      capabilities: ['supporters:read', 'supporters:write', 'content:publish', 'content:write'],
    });
    await expect(
      invoker.run(useCases.createAccessGrant, editor, {
        supporterId: reader.id,
        tierId: leden.id,
        kind: 'comp',
        reason: 'r',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      invoker.run(useCases.revokeAccessGrant, editor, {
        supporterId: reader.id,
        tierId: leden.id,
        reason: 'r',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('tier access on an article', () => {
  const article = (tierIds: string[]) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: 'Achter de muur' },
    lead: { nl: 'De eerste alinea.' },
    blocks: [],
    access: { level: 'tier' as const, tierIds },
  });

  it('publishes with a tier of this tenant', async () => {
    const { invoker, admin, tier } = setup();
    const leden = await tier('leden');
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'muur',
      document: article([leden.id]),
    });
    const live = await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    expect(live.publication.find((s) => s.locale === 'nl')!.status).toBe('published');
  });

  it('refuses an unknown tier and another tenant’s tier, without naming it', async () => {
    const { invoker, admin, tier } = setup();
    const leden = await tier('leden');
    const foreign = await tier('geheim', systemPrincipal(OTHER, 'test'));
    for (const ids of [[TIER_A], [foreign.id], [leden.id, foreign.id]]) {
      const error = await invoker
        .run(useCases.createItem, admin, { slug: 'muur', document: article(ids) })
        .catch((e) => e);
      expect(error).toMatchObject({
        code: 'invalid_input',
        issues: [{ path: 'access.tierIds', message: 'content.reference.tier-unknown' }],
      });
      expect(JSON.stringify(error.issues)).not.toContain('geheim');
    }
  });
});
