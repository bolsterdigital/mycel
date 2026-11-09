// The rules core owns and both adapters apply (ADR 001, TODO #53 PR 3): the credential gate,
// "disconnected is frozen", what an erasure does to connection intents, that it takes the
// admission seat of a signup that was never ingested under core's key, and which items a content
// list matches and in what order (`core/content/listing.ts`), and likewise a media list
// (`core/media/listing.ts`). One scenario, one
// expected record, run once over the memory adapter and once over Postgres; a rule that one
// adapter keeps on its own shows up as a difference here. Rejected: a suite per adapter, which
// is how memory came to block a `resolved` intent while Postgres kept it.
//
// The memory half always runs; the Postgres half skips without DATABASE_URL and APP_DATABASE_URL,
// and in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CENTRE,
  ConnectionIntentState,
  NO_CREDIT,
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
  const pages = {
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

  // Articles from here on, so the record above stays the five pages. The authors and the tags of
  // an earlier revision do not count: `oud` lost both in its second save.
  const sam = await invoker.run(useCases.createPerson, admin, { slug: 'sam', name: 'Sam' });
  const noor = await invoker.run(useCases.createPerson, admin, { slug: 'noor', name: 'Noor' });
  const buurt = await invoker.run(useCases.createSection, admin, {
    slug: 'buurt',
    title: { nl: 'Buurt' },
  });
  const article = (over: Record<string, unknown>) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Artikel', en: 'Article' },
    blocks: [],
    ...over,
  });
  const write = async (slug: string, over: Record<string, unknown>) => {
    clock.advance(1000);
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: article(over) as never,
    });
    return item;
  };
  const volledig = await write('volledig', {
    authorIds: [sam.id],
    sectionId: buurt.id,
    tags: ['Buurt Nieuws'],
  });
  const oud = await write('oud', { authorIds: [sam.id, noor.id], tags: ['zee'] });
  clock.advance(1000);
  await invoker.run(useCases.updateItem, admin, {
    itemId: oud.id,
    baseRevisionId: oud.latestRevisionId,
    document: article({ authorIds: [noor.id] }) as never,
  });
  const achter = await write('achter', { title: { nl: 'Alleen Nederlands' } });
  const nl = await write('nl-alleen', { locales: ['nl'], title: { nl: 'Alleen hier' } });
  const of = (type: 'article' | 'page' = 'article') => ({ type, sort: 'created' as const });
  const saved = async (id: string) =>
    (await invoker.run(useCases.getItem, admin, { itemId: id })).item.updatedAt;
  const behind = { translation: { state: 'behind' as const, locales: ['en'] } };
  const missing = { translation: { state: 'missing' as const, locales: ['en'] } };
  const absent = { translation: { state: 'missing' as const, locales: ['de'] } };
  const firstBehind = await list({ ...of(), ...behind, limit: 1 });
  const listed = await list({ slug: 'volledig' });
  return {
    ...pages,
    author: await slugs({ ...of(), authorId: sam.id }),
    authorOfLatestRevision: await slugs({ ...of(), authorId: noor.id }),
    section: await slugs({ ...of(), sectionId: buurt.id }),
    tag: await slugs({ ...of(), tag: '  BUURT   nieuws ' }),
    tagOfEarlierRevision: await slugs({ ...of(), tag: 'zee' }),
    pageHasNoAuthor: await slugs({ ...of('page'), authorId: sam.id }),
    pageHasNoTag: await slugs({ ...of('page'), tag: 'zee' }),
    // From is inclusive, before is exclusive: one moment lands in exactly one of two days.
    savedFrom: await slugs({ ...of(), updatedFrom: await saved(achter.id) }),
    savedBefore: await slugs({ ...of(), updatedBefore: await saved(achter.id) }),
    translationBehind: await slugs({ ...of(), ...behind }),
    translationMissing: await slugs({ ...of(), ...missing }),
    translationAndAuthor: await slugs({ ...of(), ...behind, authorId: sam.id }),
    translationPage: {
      slugs: firstBehind.items.map((i) => i.slug).join(' '),
      next: firstBehind.next,
      total: firstBehind.total,
    },
    translationOffset: await slugs({
      ...of(),
      ...missing,
      offset: 1,
    }),
    // Core orders what it walked, so both adapters answer in the order the others are asked in.
    translationByTitle: await slugs({ type: 'article', sort: 'title', ...absent }),
    translationBySaved: await slugs({ type: 'article', sort: 'updated', ...absent }),
    translationAfterUnknown: await slugs({
      sort: 'title',
      type: 'article',
      ...missing,
      after: uuidv7(),
    }),
    translationAfterNonMatch: await slugs({
      sort: 'title',
      direction: 'desc',
      type: 'article',
      ...missing,
      after: volledig.id,
    }),
    listed: {
      translations: listed.items[0]?.translations,
      authors: listed.items[0]?.authorIds.length,
      section: listed.items[0]?.sectionId === buurt.id,
      tags: listed.items[0]?.tags,
    },
    listedBehind: (await list({ slug: 'achter' })).items[0]?.translations,
    listedAlone: (await list({ slug: nl.slug })).items[0]?.translations,
  };
}

/** Every observation the rules decide, in one record, so the two adapters compare as a whole. */
type MediaListInput = z.input<typeof useCases.listMedia.input>;

/**
 * Files in every state a media list tells apart, listed by every filter and order. The names hold
 * what two stores would order differently; the uses hold each way an image can lack alt text, and
 * each way that looks like it but is not: decorative, a hero without alt, a featured image, a use
 * only an earlier revision had.
 */
async function observeMediaListing(invoker: Invoker, uow: UnitOfWork, admin: Principal) {
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  const add = (key: string, kind: 'image' | 'document' | 'audio', sizeBytes: number) =>
    uow.run(admin, async (ctx) => {
      const id = uuidv7();
      ids.set(key, id);
      names.set(id, key);
      await ctx.media.insert({
        id,
        kind,
        contentType:
          kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'application/pdf',
        filename: `${key}.bin`,
        checksum: '0'.repeat(64),
        sizeBytes,
        totalBytes: sizeBytes,
        width: null,
        height: null,
        variants: [],
        access: 'public',
        caption: {},
        credit: NO_CREDIT,
        source: null,
        licence: null,
        focal: CENTRE,
        state: 'ready',
        createdBy: { kind: 'system', ref: 'rules' },
        // Apart by a day each, in the order of the calls.
        createdAt: new Date(Date.UTC(2026, 0, ids.size)),
        updatedAt: new Date(Date.UTC(2026, 0, ids.size)),
      });
    });
  const FILES = [
    ['één-half', 500],
    ['Beschreven', 900],
    ['decoratief', 100],
    ['galerij', 800],
    ['hero-half', 300],
    ['hero-zonder', 200],
    ['uitgelicht', 700],
    ['ooit-half', 600],
    ['zomaar', 1000],
  ] as const;
  for (const [key, size] of FILES) await add(key, 'image', size);
  await add('notitie', 'document', 50);
  await add('geluid', 'audio', 60);

  const image = (key: string, alt: Record<string, string> | null) => ({
    type: 'image' as const,
    version: 1 as const,
    props: { mediaId: ids.get(key)!, decorative: alt === null, alt },
  });
  const both = { nl: 'Foto', en: 'Photo' };
  const save = (slug: string, overrides: Parameters<typeof pageDocument>[0]) =>
    invoker.run(useCases.createItem, admin, {
      slug,
      document: pageDocument({ title: both, locales: ['nl', 'en'], ...overrides }),
    });
  await save('media-half', { blocks: [image('één-half', { nl: 'Foto' })] });
  await save('media-heel', {
    blocks: [image('Beschreven', both), image('decoratief', null)],
  });
  await save('media-galerij', {
    blocks: [
      {
        type: 'gallery',
        version: 1,
        props: {
          images: [
            { mediaId: ids.get('Beschreven')!, decorative: false, alt: both },
            { mediaId: ids.get('galerij')!, decorative: false, alt: { en: 'Photo' } },
          ],
        },
      },
    ],
  });
  await save('media-hero-half', {
    heroImageId: ids.get('hero-half')!,
    heroAlt: { nl: 'Foto' },
  });
  await save('media-hero-zonder', {
    heroImageId: ids.get('hero-zonder')!,
    featuredImageId: ids.get('uitgelicht')!,
  });
  const { item } = await save('media-ooit', { blocks: [image('ooit-half', { nl: 'Foto' })] });
  await invoker.run(useCases.updateItem, admin, {
    itemId: item.id,
    baseRevisionId: item.latestRevisionId,
    document: pageDocument({
      title: both,
      locales: ['nl', 'en'],
      blocks: [image('ooit-half', both)],
    }),
  });
  // In the trash with a hero that lacks its English alt: no flag on the image (ADR 030 rule 2),
  // which stays used, as every trashed item keeps its usages.
  const { item: trashed } = await save('media-hero-weg', {
    heroImageId: ids.get('Beschreven')!,
    heroAlt: { nl: 'Foto' },
  });
  await invoker.run(useCases.deleteItem, admin, { itemId: trashed.id });

  const list = (input: MediaListInput) => invoker.run(useCases.listMedia, admin, input);
  const keys = async (input: MediaListInput) =>
    (await list(input)).items.map((m) => names.get(m.id)).join(' ');
  const firstByName = await list({ sort: 'name', limit: 2 });
  return {
    newest: await keys({}),
    oldest: await keys({ direction: 'asc', limit: 2 }),
    byName: await keys({ sort: 'name' }),
    byNameDescending: await keys({ sort: 'name', direction: 'desc', limit: 2 }),
    bySize: await keys({ sort: 'size', limit: 3 }),
    bySizeAscending: await keys({ sort: 'size', direction: 'asc', limit: 2 }),
    image: (await list({ kind: 'image' })).total,
    document: await keys({ kind: 'document' }),
    audio: await keys({ kind: 'audio' }),
    unused: await keys({ unused: true, sort: 'name' }),
    used: (await list({ unused: false })).total,
    missingAlt: await keys({ missingAlt: true, sort: 'name' }),
    notMissingAlt: (await list({ missingAlt: false })).total,
    missingAltAndKind: await keys({ missingAlt: true, kind: 'document' }),
    missingAltAndSearch: await keys({ missingAlt: true, q: 'HERO' }),
    page: {
      keys: firstByName.items.map((m) => names.get(m.id)).join(' '),
      next: names.get(firstByName.nextCursor ?? ''),
      total: firstByName.total,
    },
    afterNext: await keys({ sort: 'name', limit: 2, cursor: firstByName.nextCursor! }),
    afterNextDescending: await keys({
      sort: 'name',
      direction: 'desc',
      limit: 2,
      cursor: firstByName.nextCursor!,
    }),
    afterSize: await keys({ sort: 'size', limit: 2, cursor: ids.get('zomaar')! }),
    afterNewest: await keys({ limit: 2, cursor: ids.get('zomaar')! }),
    offset: await keys({ sort: 'name', offset: 9 }),
    pastTheEnd: await list({ offset: 100 }).then((p) => ({ n: p.items.length, total: p.total })),
  };
}

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
  const invoker = new Invoker(buildRegistry(), uow);
  const listing = await observeListing(invoker, admin, clock);
  const mediaListing = await observeMediaListing(invoker, uow, admin);
  return {
    credential,
    frozen,
    erased,
    seat: { ...seat, after: await seated() },
    listing,
    mediaListing,
  };
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
    author: 'volledig',
    authorOfLatestRevision: 'oud',
    section: 'volledig',
    tag: 'volledig',
    tagOfEarlierRevision: '',
    pageHasNoAuthor: '',
    pageHasNoTag: '',
    savedFrom: 'nl-alleen achter',
    savedBefore: 'oud volledig',
    translationBehind: 'achter',
    translationMissing: 'nl-alleen',
    translationAndAuthor: '',
    translationPage: { slugs: 'achter', next: null, total: 1 },
    translationOffset: '',
    translationByTitle: 'nl-alleen achter volledig oud',
    translationBySaved: 'nl-alleen achter oud volledig',
    translationAfterUnknown: '',
    // Downwards "Alleen hier" follows "Artikel", though the item named does not match itself.
    translationAfterNonMatch: 'nl-alleen',
    listed: {
      translations: { nl: 'ok', en: 'ok' },
      authors: 1,
      section: true,
      tags: ['buurt nieuws'],
    },
    listedBehind: { nl: 'ok', en: 'behind' },
    listedAlone: { nl: 'ok' },
  },
  mediaListing: {
    newest:
      'geluid notitie zomaar ooit-half uitgelicht hero-zonder hero-half galerij decoratief Beschreven één-half',
    oldest: 'één-half Beschreven',
    // The accent stands with its letter, a capital does not move a name.
    byName:
      'Beschreven decoratief één-half galerij geluid hero-half hero-zonder notitie ooit-half uitgelicht zomaar',
    byNameDescending: 'zomaar uitgelicht',
    bySize: 'zomaar Beschreven galerij',
    bySizeAscending: 'notitie geluid',
    image: 9,
    document: 'notitie',
    audio: 'geluid',
    unused: 'geluid notitie zomaar',
    used: 8,
    // Not decoratief, hero-zonder or uitgelicht, and not ooit-half: its latest revision has both.
    missingAlt: 'één-half galerij hero-half',
    notMissingAlt: 8,
    missingAltAndKind: '',
    missingAltAndSearch: 'hero-half',
    page: { keys: 'Beschreven decoratief', next: 'decoratief', total: 11 },
    afterNext: 'één-half galerij',
    afterNextDescending: 'Beschreven',
    afterSize: 'Beschreven galerij',
    afterNewest: 'ooit-half uitgelicht',
    offset: 'uitgelicht zomaar',
    pastTheEnd: { n: 0, total: 11 },
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
