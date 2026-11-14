// Site navigation over Postgres (ADR 036, migration 0056): the same fixtures as
// packages/core/src/navigation/service.test.ts against the real adapter, plus what memory cannot
// prove: RLS between tenants, the batched target read in one statement, and the lock order of a
// save, a publication and a delete that race (`nav-concurrency`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Invoker, anonymousPrincipal, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import type { NavigationDocument, Principal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  navBasic,
  navConcurrency,
  navOffline,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('navigation conformance (Postgres)', () => {
  const owner = createDb(operatorUrl);
  const app = createDb(appUrl);
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    })
  );
  const run = <K extends keyof typeof useCases>(name: K, p: Principal, input: unknown) =>
    invoker.run(useCases[name] as never, p, input as never) as Promise<any>;
  let a: Principal;
  let b: Principal;
  // A tenant per test: a published menu of one test would block another's saves (rule 9).
  const tenant = async (name: string) =>
    systemPrincipal(
      (await testTenant(owner, `nav-${name}-${runSuffix()}`, { name: 'N', locales: ['nl', 'en'] }))
        .id,
      'test'
    );
  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    b = await tenant('b');
  });
  beforeEach(async () => {
    a = await tenant('a');
  });
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  async function page(
    p: Principal,
    slug: string,
    extra: Record<string, unknown> = {},
    publish = ['nl', 'en']
  ) {
    const { item, revision } = await run('createItem', p, {
      slug: `${slug}-${runSuffix()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `${slug} nl`, en: `${slug} en` },
        blocks: [],
        ...extra,
      },
    });
    for (const locale of publish)
      await run('publishItem', p, { itemId: item.id, revisionId: revision.id, locale });
    return item.id as string;
  }

  const head = async (p: Principal) =>
    (await run('getNavigation', p, {})).revisionId as string | null;
  const save = async (p: Principal, document: NavigationDocument) =>
    run('updateNavigation', p, { baseRevisionId: await head(p), document });

  it('nav-basic: saves, publishes per locale and resolves only in its own tenant', async () => {
    const ids = {
      about: await page(a, 'over'),
      news: await page(a, 'nieuws', { featured: { title: { nl: 'Kort nieuws' } } }),
      campaign: await page(a, 'teken'),
      privacy: await page(a, 'privacy'),
    };
    const saved = await save(a, navBasic(ids));
    for (const locale of ['nl', 'en'])
      await run('publishNavigation', a, { revisionId: saved.revisionId, locale });
    const visitor = anonymousPrincipal(a.tenantId, ['content:read']);
    const nl = await run('resolveNavigation', visitor, { locale: 'nl' });
    expect(nl.main.nodes[0]).toMatchObject({
      label: 'over nl',
      target: { kind: 'content', itemId: ids.about },
    });
    expect(nl.main.nodes[3].children[0].label).toBe('Kort nieuws');
    expect(
      (await run('resolveNavigation', visitor, { locale: 'en' })).main.nodes[3].children[0].label
    ).toBe('nieuws en');

    // Tenant B sees none of it, and cannot link to A's items: they do not exist there.
    expect(await head(b)).toBeNull();
    expect(
      (
        await run('resolveNavigation', anonymousPrincipal(b.tenantId, ['content:read']), {
          locale: 'nl',
        })
      ).main
    ).toBeNull();
    await expect(save(b, navBasic(ids))).rejects.toMatchObject({ code: 'invalid_input' });

    // The delete refusal names the menus of the draft and the published revision.
    await expect(run('deleteItem', a, { itemId: ids.about })).rejects.toMatchObject({
      code: 'conflict',
      issues: [
        expect.objectContaining({
          message: 'content.delete.in-navigation',
          params: { count: '2', menus: 'Hoofdmenu, Voet: over' },
        }),
      ],
    });
  });

  it('nav-offline: hides restricted and offline targets, keeps a labelled branch', async () => {
    const ids = {
      parent: await page(a, 'campagnes'),
      child: await page(a, 'actie'),
      lonely: await page(a, 'alleen', {}, ['nl']),
      anchored: await page(a, 'anker'),
      trashed: await page(a, 'prullenbak'),
      foreign: await page(a, 'nog-een'),
      restricted: await page(a, 'leden', { access: { level: 'members' } }),
    };
    const saved = await save(a, navOffline(ids));
    await run('publishNavigation', a, { revisionId: saved.revisionId, locale: 'nl' });
    await run('unpublishItem', a, { itemId: ids.parent, locale: 'nl' });
    const nl = await run('resolveNavigation', anonymousPrincipal(a.tenantId, ['content:read']), {
      locale: 'nl',
    });
    expect(nl.main.nodes.map((n: { id: string; kind: string }) => `${n.id}:${n.kind}`)).toEqual([
      'parent:group',
      'empty-group:group',
      'anchored:link',
      'trashed:link',
      'foreign:link',
    ]);
    expect(nl.main.nodes[2].target.anchor).toBeUndefined();
  });

  it('nav-concurrency: a save, a publication and a delete that race keep the lock order', async () => {
    const target = await page(a, 'doel');
    const base = await save(a, navConcurrency());
    const doc = navConcurrency();
    doc.menus[0]!.nodes.push({
      id: 'doel',
      kind: 'link',
      target: { kind: 'content', itemId: target },
    });
    const raced = await Promise.allSettled([
      run('updateNavigation', a, { baseRevisionId: base.revisionId, document: doc }),
      run('deleteItem', a, { itemId: target }),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of raced)
      if (r.status === 'rejected')
        expect((r.reason as { code: string }).code).toMatch(/^(conflict|invalid_input)$/);

    // Publishing while a target goes offline: no deadlock, and the result resolves either way.
    const other = await page(a, 'ander');
    const withOther = navConcurrency();
    withOther.menus[0]!.nodes.push({
      id: 'ander',
      kind: 'link',
      target: { kind: 'content', itemId: other },
    });
    const latest = await save(a, withOther);
    const both = await Promise.allSettled([
      run('publishNavigation', a, { revisionId: latest.revisionId, locale: 'nl' }),
      run('unpublishItem', a, { itemId: other, locale: 'nl' }),
    ]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const nl = await run('resolveNavigation', anonymousPrincipal(a.tenantId, ['content:read']), {
      locale: 'nl',
    });
    expect(nl.main.nodes.map((n: { id: string }) => n.id)).not.toContain('ander');
  });
});
