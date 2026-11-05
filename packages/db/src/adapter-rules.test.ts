// The rules core owns and both adapters apply (ADR 001, TODO #53 PR 3): the credential gate,
// "disconnected is frozen", what an erasure does to connection intents, that it takes the
// admission seat of a signup that was never ingested under core's key, and which items a content
// list matches and in what order (`core/content/listing.ts`). One scenario, one
// expected record, run once over the memory adapter and once over Postgres; a rule that one
// adapter keeps on its own shows up as a difference here. Rejected: a suite per adapter, which
// is how memory came to block a `resolved` intent while Postgres kept it.
//
// The memory half always runs; the Postgres half skips without DATABASE_URL and APP_DATABASE_URL,
// and in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ConnectionIntentState,
  Invoker,
  buildRegistry,
  erasedIntentState,
  systemPrincipal,
  useCases,
  type ConnectionIntent,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryUnitOfWork,
  memoryPlatform,
  pageDocument,
  probeForm,
  runSuffix,
} from '@mycel/core/testing';
import { applyErasures, createDb, createUnitOfWork, migrate, uuidv7, uuidv7Ids } from './index.js';
import { closeTenantWork, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

interface Adapter {
  uow: UnitOfWork;
  /** The clock `uow` reads, so the scenario can put its saves a second apart. */
  clock: FakeClock;
  tenant(): Promise<string>;
  apply(tenantId: string): Promise<unknown>;
}

const connection = {
  provider: 'webhook' as const,
  accountRef: null,
  externalOwner: 'Example organisation',
  maintainer: 'Maintainer',
  purpose: 'Newsletter',
  direction: 'outbound' as const,
  dataAuthority: 'mycel' as const,
  consentAuthority: 'mycel' as const,
  consentScopes: ['newsletter:main'],
  formIds: [],
  destination: 'https://hooks.example.org/mycel',
  contractVersion: 'v1',
  adapterVersion: 'v1',
};

type ListInput = z.input<typeof useCases.listItems.input>;

/**
 * Five pages, one in each publication state of Dutch, listed by every filter and order: what
 * matches, in which order, how many in all and where the next page starts. The titles hold what
 * two stores would order or match differently on their own: an accent, a capital, a space, and
 * the two wildcards of `like`.
 */
async function observeListing(invoker: Invoker, admin: Principal, clock: FakeClock) {
  const make = async (slug: string, nl: string, en?: string) => {
    clock.advance(1000);
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: pageDocument({ title: { nl, ...(en ? { en } : {}) } }),
    });
    return item;
  };
  const publish = async (item: { id: string; latestRevisionId: string }) => {
    clock.advance(1000);
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
  };
  await make('de-week', 'De week');
  const deel = await make('deel', 'Deel', 'Zebra part');
  const dag = await make('een-dag', 'Één dag', 'One day');
  const procent = await make('procent', '100% zeker');
  await make('appel', 'appeltaart_recept');
  await publish(deel);
  await publish(dag);
  clock.advance(1000);
  await invoker.run(useCases.updateItem, admin, {
    itemId: dag.id,
    baseRevisionId: dag.latestRevisionId,
    document: pageDocument({ title: { nl: 'Één dag', en: 'One day' } }),
  });
  await publish(procent);
  clock.advance(1000);
  await invoker.run(useCases.unpublishItem, admin, { itemId: procent.id, locale: 'nl' });

  const slugOf = new Map<string, string>();
  const list = async (input: ListInput) => {
    const page = await invoker.run(useCases.listItems, admin, input);
    for (const i of page.items) slugOf.set(i.id, i.slug);
    return page;
  };
  const slugs = async (input: ListInput) => (await list(input)).items.map((i) => i.slug).join(' ');
  const firstByTitle = await list({ sort: 'title', limit: 2 });
  return {
    created: await slugs({}),
    createdAscending: await slugs({ sort: 'created', direction: 'asc' }),
    updated: await slugs({ sort: 'updated' }),
    title: await slugs({ sort: 'title' }),
    titleDescending: await slugs({ sort: 'title', direction: 'desc' }),
    titleInEnglish: await slugs({ sort: 'title', locale: 'en' }),
    search: await slugs({ q: 'DE' }),
    searchOtherLocale: await slugs({ q: 'zebra' }),
    searchPercent: await slugs({ q: '%' }),
    searchUnderscore: await slugs({ q: '_' }),
    searchBackslash: await slugs({ q: '\\' }),
    draft: await slugs({ status: 'draft' }),
    published: await slugs({ status: 'published' }),
    unpublished: await slugs({ status: 'unpublished' }),
    changed: await slugs({ hasUnpublishedChanges: true }),
    unchanged: await slugs({ hasUnpublishedChanges: false }),
    draftInEnglish: await slugs({ status: 'draft', locale: 'en' }),
    draftInGerman: await slugs({ status: 'draft', locale: 'de' }),
    searchAndState: await slugs({ q: 'e', status: 'published', sort: 'title' }),
    page: {
      slugs: firstByTitle.items.map((i) => i.slug).join(' '),
      next: slugOf.get(firstByTitle.next ?? ''),
      total: firstByTitle.total,
    },
    afterNext: await slugs({ sort: 'title', limit: 2, after: firstByTitle.next! }),
    afterNextDescending: await slugs({
      sort: 'title',
      direction: 'desc',
      after: firstByTitle.next!,
    }),
    afterUpdated: await slugs({ sort: 'updated', after: dag.id }),
    offset: await slugs({ sort: 'title', offset: 4 }),
    afterUnknownByTitle: await slugs({ sort: 'title', after: uuidv7() }),
    afterUnknownByCreation: await slugs({ after: uuidv7() }),
    total: (await list({ q: 'e', limit: 1 })).total,
  };
}

/** Every observation the rules decide, in one record, so the two adapters compare as a whole. */
async function observe({ uow, clock, tenant, apply }: Adapter) {
  const t = await tenant();
  const admin = systemPrincipal(t, 'adapter-rules');
  const worker = systemPrincipal(t, 'connections.run');
  const other = systemPrincipal(t, 'connections.other');
  const at = new Date('2026-10-28T08:00:00Z');
  const read = (p: typeof admin, id: string, version: number) =>
    uow.run(p, (ctx) => ctx.connections.credential(id, version));

  const created = await uow.run(admin, (ctx) =>
    ctx.connections.insert({ ...connection, id: uuidv7() }, at)
  );
  const withKey = (await uow.run(admin, (ctx) =>
    ctx.connections.replaceCredential(created.id, created.version, 'rule-secret', at)
  ))!;
  const paused = await read(worker, created.id, 1);
  const active = (await uow.run(admin, (ctx) =>
    ctx.connections.state(created.id, withKey.version, 'active', at)
  ))!;
  const credential = {
    paused,
    activeWorker: await read(worker, created.id, 1),
    activeStaleVersion: await read(worker, created.id, 2),
    activeOtherJob: await read(other, created.id, 1),
    activeAdmin: await read(admin, created.id, 1),
  };

  // A stale base version fails like a frozen row, so the frozen checks use the current one.
  const gone = (await uow.run(admin, (ctx) =>
    ctx.connections.state(created.id, active.version, 'disconnected', at)
  ))!;
  const frozen = {
    hasCredential: gone.hasCredential,
    read: await read(worker, created.id, 1),
    update: await uow.run(admin, (ctx) =>
      ctx.connections.update(created.id, gone.version, { purpose: 'Changed' }, at)
    ),
    resume: await uow.run(admin, (ctx) =>
      ctx.connections.state(created.id, gone.version, 'active', at)
    ),
    replaceCredential: await uow.run(admin, (ctx) =>
      ctx.connections.replaceCredential(created.id, gone.version, 'again', at)
    ),
  };

  // One intent per state for one supporter, against a second, live connection.
  const live = await uow.run(admin, (ctx) =>
    ctx.connections.insert({ ...connection, id: uuidv7() }, at)
  );
  const supporterId = uuidv7();
  const intents = new Map<string, ConnectionIntentState>();
  for (const state of ConnectionIntentState.options) {
    const row: ConnectionIntent = {
      id: uuidv7(),
      connectionId: live.id,
      businessId: uuidv7(),
      connectionVersion: live.version,
      credentialVersion: 1,
      source: 'form',
      mappingVersion: 'v1',
      supporterId,
      scope: 'newsletter:main',
      actor: { kind: 'system', id: 'adapter-rules' },
      key: `adapter-rules:${state}:${uuidv7()}`,
      state,
      failure: null,
      attempts: 1,
      revision: 0,
      leaseToken: null,
      leaseUntil: null,
      nextAt: at,
      createdAt: at,
      updatedAt: at,
    };
    await uow.run(admin, (ctx) => ctx.connectionIntents.insert(row));
    intents.set(row.id, state);
  }
  // A signup that holds a seat and was never ingested, registered as a restore would bring it
  // back: the register knows the person, no projection does.
  const formId = uuidv7();
  await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
  const submitted = await new Invoker(buildRegistry(), uow).run(useCases.submitForm, admin, {
    formId,
    values: { email: 'Seat@Example.org ', consent: true },
    locale: 'nl',
  });
  const seated = () => uow.run(admin, (ctx) => ctx.admissions.pending('seat@example.org'));
  const seat = { submitted: submitted.status, before: await seated() };
  await uow.run(admin, (ctx) => ctx.erasures.register(supporterId, 'rules@example.org'));
  await uow.run(admin, (ctx) => ctx.erasures.register(uuidv7(), 'SEAT@example.org'));
  await apply(t);
  const erased: Record<string, unknown> = {};
  for (const [id, before] of intents) {
    const row = (await uow.run(admin, (ctx) => ctx.connectionIntents.get(id)))!;
    erased[before] = { state: row.state, failure: row.failure, supporterId: row.supporterId };
  }
  const listing = await observeListing(new Invoker(buildRegistry(), uow), admin, clock);
  return { credential, frozen, erased, seat: { ...seat, after: await seated() }, listing };
}

const expected = {
  credential: {
    paused: null,
    activeWorker: 'rule-secret',
    activeStaleVersion: null,
    activeOtherJob: null,
    activeAdmin: null,
  },
  frozen: {
    hasCredential: false,
    read: null,
    update: null,
    resume: null,
    replaceCredential: null,
  },
  erased: Object.fromEntries(
    ConnectionIntentState.options.map((s) => [
      s,
      { state: erasedIntentState(s), failure: 'erasure', supporterId: null },
    ])
  ),
  seat: { submitted: 'accepted', before: true, after: false },
  listing: {
    created: 'appel procent een-dag deel de-week',
    createdAscending: 'de-week deel een-dag procent appel',
    // A publication is not a save: only the second save of `een-dag` moved it.
    updated: 'een-dag appel procent deel de-week',
    title: 'procent appel de-week deel een-dag',
    titleDescending: 'een-dag deel de-week appel procent',
    // "One day" and "Zebra part"; the others fall to their Dutch title.
    titleInEnglish: 'procent appel de-week een-dag deel',
    search: 'deel de-week',
    searchOtherLocale: 'deel',
    searchPercent: 'procent',
    searchUnderscore: 'appel',
    searchBackslash: '',
    draft: 'appel de-week',
    published: 'een-dag deel',
    unpublished: 'procent',
    changed: 'een-dag',
    unchanged: 'appel procent deel de-week',
    draftInEnglish: 'appel procent een-dag deel de-week',
    draftInGerman: '',
    searchAndState: 'deel een-dag',
    page: { slugs: 'procent appel', next: 'appel', total: 5 },
    afterNext: 'de-week deel',
    afterNextDescending: 'procent',
    afterUpdated: 'appel procent deel de-week',
    offset: 'een-dag',
    afterUnknownByTitle: '',
    afterUnknownByCreation: 'appel procent een-dag deel de-week',
    total: 5,
  },
};

it('keeps an intent whose state says what happened, and blocks the rest', () => {
  expect(
    Object.fromEntries(ConnectionIntentState.options.map((s) => [s, erasedIntentState(s)]))
  ).toEqual({
    pending: 'blocked',
    unknown: 'unknown',
    succeeded: 'succeeded',
    blocked: 'blocked',
    failed: 'blocked',
    resolved: 'resolved',
  });
});

describe('adapter rules, memory', () => {
  it('applies the core rules', async () => {
    const clock = new FakeClock(new Date());
    const uow = new MemoryUnitOfWork({ clock });
    const result = await observe({
      uow,
      clock,
      tenant: async () => uuidv7(),
      apply: (t) => uow.run(systemPrincipal(t, 'erasures'), (ctx) => ctx.erasures.apply()),
    });
    expect(result).toEqual(expected);
  });
});

describe.skipIf(skip)('adapter rules, postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const clock = new FakeClock(new Date());
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    connectionCredentialKey: '20'.repeat(32),
  });
  const run = runSuffix();
  const tenants: string[] = [];

  beforeAll(() => migrate(operatorUrl, { log: () => {} }));
  afterAll(async () => {
    await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('applies the core rules', async () => {
    const result = await observe({
      uow,
      clock,
      async tenant() {
        const { id } = await testTenant(operatorDb, `rules-${run}`, { name: 'Rules' });
        tenants.push(id);
        return id;
      },
      apply: (t) => applyErasures(operatorDb, t),
    });
    expect(result).toEqual(expected);
  });
});
