// Access tiers and grants against Postgres (migration 0068, ADR 016 rule 2, ADR 019 rules 2 to 4
// and 8): what the in-memory store cannot prove. A tier is invisible without a tenant context and
// to another tenant, so an article can only be published behind a tier of its own tenant; grants
// given at the same time for one supporter fold as the serial log; and an erasure empties the
// standing grants and the events that named the tier. The policy itself, `hasAccess`, is pure and
// lives in packages/core/src/content/access/access.test.ts. The export round trip and the
// catalog-wide RLS check take their tier and grant rows from the fixtures of
// portability/export.conformance.test.ts and rls.conformance.test.ts.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  SupporterEvent,
  buildRegistry,
  hasAccess,
  ingest,
  readerOf,
  rebuildProjection,
  systemPrincipal,
  tombstoneEmail,
  useCases,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createUnitOfWork,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('access conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  let a = systemPrincipal('', 'test');
  let b = systemPrincipal('', 'test');

  const supporter = async (principal: typeof a, email: string) => {
    await uow.run(principal, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `${run}-${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: new Date(Date.now() - 60_000).toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: email,
          props: { list: 'news' },
        })
      )
    );
    return invoker.run(useCases.getSupporter, principal, { email });
  };
  const tier = (principal: typeof a, slug: string) =>
    invoker.run(useCases.createAccessTier, principal, { slug, name: { nl: slug } });
  const article = (tierIds: string[]) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: 'Achter de muur' },
    lead: { nl: 'De eerste alinea.' },
    blocks: [],
    access: { level: 'tier' as const, tierIds },
  });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    a = systemPrincipal((await testTenant(operatorDb, `acc-a-${run}`)).id, 'test');
    b = systemPrincipal((await testTenant(operatorDb, `acc-b-${run}`)).id, 'test');
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('keeps tiers per tenant: same slug twice, no read across, none without a tenant', async () => {
    const mine = await tier(a, 'leden');
    const theirs = await tier(b, 'leden');
    expect(theirs.id).not.toBe(mine.id);
    await expect(tier(a, 'leden')).rejects.toMatchObject({ code: 'conflict' });
    await expect(invoker.run(useCases.getAccessTier, b, { tierId: mine.id })).rejects.toMatchObject(
      { code: 'not_found' }
    );
    expect((await invoker.run(useCases.listAccessTiers, b, {})).tiers.map((t) => t.id)).toEqual([
      theirs.id,
    ]);

    // Forced RLS: the app role without a tenant context sees and writes nothing.
    expect(await appDb.selectFrom('access_tiers').select('id').execute()).toEqual([]);
    await expect(
      sql`insert into access_tiers (id, tenant_id, slug, name, kind, created_at, updated_at)
          values (${uuidv7()}, ${a.tenantId}, 'los', '{"nl":"Los"}', 'free', now(), now())`.execute(
        appDb
      )
    ).rejects.toThrow(/row-level security/);
    // Inside tenant B, a row for tenant A is refused by the policy's check.
    await expect(
      withTenant(appDb, b, (trx) =>
        sql`insert into access_tiers (id, tenant_id, slug, name, kind, created_at, updated_at)
            values (${uuidv7()}, ${a.tenantId}, 'smokkel', '{"nl":"X"}', 'free', now(), now())`.execute(
          trx
        )
      )
    ).rejects.toThrow(/row-level security/);
    // No tier is ever deleted: the app role has no such grant.
    await expect(
      withTenant(appDb, a, (trx) =>
        trx.deleteFrom('access_tiers').where('id', '=', mine.id).execute()
      )
    ).rejects.toThrow(/permission denied/);
  });

  it('renames a tier on its base and lets exactly one of two concurrent renames win', async () => {
    const made = await tier(a, 'pers');
    const outcomes = await Promise.allSettled(
      ['Pers', 'Journalisten'].map((nl) =>
        invoker.run(useCases.updateAccessTier, a, {
          tierId: made.id,
          baseUpdatedAt: made.updatedAt,
          name: { nl },
        })
      )
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes.find((o) => o.status === 'fulfilled');
    const stored = await invoker.run(useCases.getAccessTier, a, { tierId: made.id });
    expect(stored).toEqual(winner?.status === 'fulfilled' ? winner.value : null);
    expect(stored).toMatchObject({ slug: 'pers', kind: 'free' });
  });

  it('publishes behind a tier of the same tenant only', async () => {
    const mine = await tier(a, 'donateurs');
    const { item, revision } = await invoker.run(useCases.createItem, a, {
      slug: `muur-${run}`,
      document: article([mine.id]),
    });
    const live = await invoker.run(useCases.publishItem, a, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    expect(live.publication.find((s) => s.locale === 'nl')!.status).toBe('published');

    for (const ids of [[mine.id], [uuidv7()]]) {
      await expect(
        invoker.run(useCases.createItem, b, { slug: `muur-${run}`, document: article(ids) })
      ).rejects.toMatchObject({
        code: 'invalid_input',
        issues: [{ path: 'access.tierIds', message: 'content.reference.tier-unknown' }],
      });
    }
  });

  it('stores a grant with its end, replaces and revokes it, and equals the fold of the log', async () => {
    const reader = await supporter(a, `reader-${run}@example.org`);
    const leden = await tier(a, 'abonnees');
    const until = new Date(Date.now() + 60_000).toISOString();
    const granted = await invoker.run(useCases.createAccessGrant, a, {
      supporterId: reader.id,
      tierId: leden.id,
      kind: 'comp',
      reason: 'Persweek',
      until,
    });
    expect(granted.grants).toMatchObject([{ tierId: leden.id, kind: 'comp', until }]);
    const stored = await invoker.run(useCases.getSupporter, a, { email: reader.email });
    expect(stored).toEqual(granted);
    const target = { access: { level: 'tier' as const, tierIds: [leden.id] } };
    expect(hasAccess(readerOf(stored), target, new Date(Date.parse(until) - 1))).toBe(true);
    expect(hasAccess(readerOf(stored), target, new Date(until))).toBe(false);

    // Another tenant can neither grant on this supporter nor use this tier.
    await expect(
      invoker.run(useCases.createAccessGrant, b, {
        supporterId: reader.id,
        tierId: leden.id,
        kind: 'comp',
        reason: 'r',
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    const revoked = await invoker.run(useCases.revokeAccessGrant, a, {
      supporterId: reader.id,
      tierId: leden.id,
      reason: 'Voorbij',
    });
    expect(revoked.grants).toEqual([]);
    const log = await uow.run(a, (ctx) => ctx.supporters.eventsFor(reader.id));
    expect(log.map((e) => e.type)).toEqual([
      'newsletter.subscribed',
      'access.granted',
      'access.revoked',
    ]);
    expect(revoked).toEqual(rebuildProjection(log));
  });

  it('folds grants given at the same time for one supporter as the serial log (ADR 019 rule 3)', async () => {
    const reader = await supporter(a, `par-${run}@example.org`);
    const tiers = await Promise.all(['een', 'twee', 'drie'].map((slug) => tier(a, slug)));
    await Promise.all(
      tiers.map((t) =>
        invoker.run(useCases.createAccessGrant, a, {
          supporterId: reader.id,
          tierId: t.id,
          kind: 'gift',
          reason: 'r',
        })
      )
    );
    const stored = await invoker.run(useCases.getSupporter, a, { email: reader.email });
    expect(stored.grants.map((g) => g.tierId).sort()).toEqual(tiers.map((t) => t.id).sort());
    const log = await uow.run(a, (ctx) => ctx.supporters.eventsFor(reader.id));
    expect(stored).toEqual(rebuildProjection(log));
  });

  it('empties the grants and the events that named the tier on erasure, also after a re-fold', async () => {
    const reader = await supporter(a, `gone-${run}@example.org`);
    const leden = await tier(a, 'vrienden');
    await invoker.run(useCases.createAccessGrant, a, {
      supporterId: reader.id,
      tierId: leden.id,
      kind: 'comp',
      reason: `Vraag van gone-${run}@example.org`,
    });
    await uow.run(a, (ctx) => ctx.erasures.register(reader.id, reader.email));
    await applyErasures(operatorDb, a.tenantId);

    const erased = await uow.run(a, (ctx) => ctx.supporters.getProjectionById(reader.id));
    expect(erased).toMatchObject({ email: tombstoneEmail(reader.id), grants: [] });
    expect(readerOf(erased)).toBeNull();
    const log = await uow.run(a, (ctx) => ctx.supporters.eventsFor(reader.id));
    expect(log).toHaveLength(2);
    expect(log.every((e) => Object.keys(e.props).length === 0)).toBe(true);
    expect(rebuildProjection(log)!.grants).toEqual([]);
    expect(await applyErasures(operatorDb, a.tenantId)).toBe(0);
    await expect(
      invoker.run(useCases.createAccessGrant, a, {
        supporterId: reader.id,
        tierId: leden.id,
        kind: 'comp',
        reason: 'r',
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
