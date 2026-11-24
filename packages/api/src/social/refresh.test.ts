// Run the real cache and publication query under the application role. Provider fixtures
// are responses to the adapter, so this suite needs no external accounts or sockets.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCESS, Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '@mycel/db/testing';
import type { PublicJson } from './public-json.js';
import { conversationService } from './refresh.js';

const { skip, operator, app } = requireDatabase('app');
const origin = 'https://social.example.org';
const profile = `${origin}/@otterdam`;
const profiles = { mastodon: profile };
const href = (id: number) => `${profile}/${id}`;
const status = (id: number, changes = {}) => ({
  id: String(id),
  visibility: 'public',
  url: href(id),
  account: { acct: 'otterdam', url: profile },
  replies_count: 0,
  reblogs_count: 2,
  ...changes,
});
const hour = 3600_000;

describe.skipIf(skip)('conversation refresh with published content under tenant RLS', () => {
  const db = createDb(app);
  const owner = createDb(operator);
  const tenants: string[] = [];
  let now = new Date();
  const clock = { now: () => now };
  const uow = createUnitOfWork(db, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const get = vi.fn<PublicJson>();
  const deps = { db, uow, clock, identity: { tenantAccess: async () => DEFAULT_ACCESS }, get };
  const service = conversationService({
    ...deps,
    providers: { bluesky: false, mastodon: new Set([origin]) },
  });
  const advance = (milliseconds: number) => {
    now = new Date(now.getTime() + milliseconds);
  };

  beforeAll(async () => migrateSchema(operator));
  afterAll(async () => {
    await closeTenantWork(owner, tenants);
    await Promise.all([db.destroy(), owner.destroy()]);
  });

  async function setup() {
    const tenant = await testTenant(owner, `social-${runSuffix()}`, { locales: ['nl', 'en'] });
    tenants.push(tenant.id);
    const principal = systemPrincipal(tenant.id, 'test:social-conversation');
    const { value, version } = await invoker.run(useCases.getSiteChrome, principal, {});
    await invoker.run(useCases.updateSiteChrome, principal, {
      baseVersion: version,
      chrome: { ...value, social: profiles },
    });
    return principal;
  }

  it('ignores drafts and restricted posts, isolates two tenants and updates or expires the snapshot', async () => {
    const first = await setup();
    const second = await setup();
    const document = (id: number) => ({
      type: 'article' as const,
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Artikel', en: 'Article' },
      lead: { nl: 'Inleiding', en: 'Introduction' },
      blocks: [
        {
          type: 'social-conversation' as const,
          version: 1 as const,
          props: { mastodonPost: { nl: href(id), en: href(id + 100) } },
        },
      ],
    });
    const create = (slug: string, id: number, restricted = false) =>
      invoker.run(useCases.createItem, first, {
        slug,
        document: {
          ...document(id),
          ...(restricted ? { access: { level: 'members' as const, teaser: 'lead' as const } } : {}),
        },
      });
    const publish = (itemId: string, revisionId: string) =>
      invoker.run(useCases.publishItem, first, { itemId, revisionId, locale: 'nl' });
    const article = await create('conversation', 1001);
    const gated = await create('gated', 1009, true);
    await publish(article.item.id, article.revision.id);
    await publish(gated.item.id, gated.revision.id);
    const draft = await invoker.run(useCases.updateItem, first, {
      itemId: article.item.id,
      baseRevisionId: article.revision.id,
      document: document(1002),
    });
    const counts = (id: number) => service.read(first, profiles, [href(id)]);
    get.mockResolvedValueOnce({ status: 200, body: status(1001) });
    await service.refresh(first.tenantId);
    expect(get.mock.calls.map(([url]) => url.pathname)).toEqual(['/api/v1/statuses/1001']);
    expect((await counts(1001)).get(href(1001))).toEqual({ replies: 0, reposts: 2 });
    expect((await service.read(second, profiles, [href(1001)])).size).toBe(0);

    await service.refresh(first.tenantId);
    expect(get).toHaveBeenCalledTimes(1);
    const off = conversationService({
      ...deps,
      providers: { bluesky: false, mastodon: new Set() },
    });
    await off.refresh(first.tenantId);
    expect((await off.read(first, profiles, [href(1001)])).size).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);

    advance(hour);
    get.mockRejectedValueOnce(new Error('provider unavailable'));
    await service.refresh(first.tenantId);
    expect((await counts(1001)).size).toBe(1);
    advance(hour);
    expect((await counts(1001)).size).toBe(0);

    await publish(article.item.id, draft.revision.id);
    get.mockResolvedValueOnce({ status: 200, body: status(1002, { replies_count: undefined }) });
    await service.refresh(first.tenantId);
    expect(get.mock.calls.slice(1).map(([url]) => url.pathname)).toEqual([
      '/api/v1/statuses/1001',
      '/api/v1/statuses/1002',
    ]);
    expect((await counts(1002)).get(href(1002))).toEqual({ reposts: 2 });

    advance(hour);
    get.mockResolvedValueOnce({ status: 200, body: status(1002, { visibility: 'private' }) });
    await service.refresh(first.tenantId);
    expect((await counts(1002)).size).toBe(0);
    expect(
      (
        await invoker.run(useCases.getPublished, first, {
          type: 'article',
          slug: 'conversation',
          locale: 'nl',
        })
      ).blocks[0]
    ).toMatchObject({ props: { mastodonPost: { nl: href(1002) } } });
  });
});
