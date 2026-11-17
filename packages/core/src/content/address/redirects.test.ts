// Old addresses (migration 0062): a rename of a published item keeps the old slug as an address that
// forwards to the item, holds it against other items, and goes only on an explicit removal.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';

const OTHER_TENANT = '01900000-0000-7000-8000-00000000cccc';

const doc = (type: 'page' | 'article' = 'page') => ({
  type,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Over ons', en: 'About us' },
  blocks: [],
});

describe('old addresses', () => {
  let invoker: Invoker;
  let admin: Principal;
  const visitor = (tenant = TENANT) => anonymousPrincipal(tenant, ['content:read']);

  beforeEach(() => {
    const uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
  });

  const create = async (slug: string, type: 'page' | 'article' = 'page') =>
    (await invoker.run(useCases.createItem, admin, { slug, document: doc(type) })).item;
  const publish = async (itemId: string, locale: string) => {
    const item = await invoker.run(useCases.getItem, admin, { itemId });
    await invoker.run(useCases.publishItem, admin, {
      itemId,
      revisionId: item.revision.id,
      locale,
    });
  };
  const rename = (itemId: string, slug: string, p: Principal = admin) =>
    invoker.run(useCases.updateSlug, p, { itemId, slug });
  const resolve = (slug: string, locale = 'nl', p = visitor(), type: 'page' | 'article' = 'page') =>
    invoker.run(useCases.resolveRedirect, p, { type, slug, locale });
  const olds = async (itemId: string) =>
    (await invoker.run(useCases.listRedirects, admin, { itemId })).redirects.map((r) => r.slug);

  it('moves a never-published item without a trace', async () => {
    const item = await create('over-ons');
    await rename(item.id, 'wie-we-zijn');
    expect(await olds(item.id)).toEqual([]);
    expect(await create('over-ons')).toBeDefined();
  });

  it('keeps the old slug of a published item, which forwards in the locale asked', async () => {
    const item = await create('over-ons');
    await publish(item.id, 'nl');
    const moved = await rename(
      item.id,
      'wie-we-zijn',
      principal({ capabilities: ['content:write', 'content:read'] })
    );
    expect(moved.slug).toBe('wie-we-zijn');
    // Nothing is published by a rename: the address is the item's.
    expect(moved.latestRevisionId).toBe(item.latestRevisionId);
    expect(await olds(item.id)).toEqual(['over-ons']);
    expect(await resolve('over-ons')).toEqual({ type: 'page', slug: 'wie-we-zijn' });
    // English is not published: no forward, the same 404 the new address gives.
    await expect(resolve('over-ons', 'en')).rejects.toMatchObject({ code: 'not_found' });
    // An unknown slug and the other type's space forward nothing.
    await expect(resolve('nergens')).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolve('over-ons', 'nl', visitor(), 'article')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('forwards every old slug of a chain to the current one, and a move back takes it out', async () => {
    const item = await create('a');
    await publish(item.id, 'nl');
    await rename(item.id, 'b');
    await rename(item.id, 'c');
    expect(await olds(item.id)).toEqual(['a', 'b']);
    expect(await resolve('a')).toEqual({ type: 'page', slug: 'c' });
    expect(await resolve('b')).toEqual({ type: 'page', slug: 'c' });
    await rename(item.id, 'a');
    expect((await olds(item.id)).sort()).toEqual(['b', 'c']);
    await expect(resolve('a')).rejects.toMatchObject({ code: 'not_found' });
    expect(await resolve('c')).toEqual({ type: 'page', slug: 'a' });
  });

  it('holds an old slug against another item until it is removed', async () => {
    const item = await create('over-ons');
    await publish(item.id, 'nl');
    await rename(item.id, 'wie-we-zijn');
    const taken = { code: 'conflict', issues: [{ path: 'slug', message: 'content.slug.taken' }] };
    await expect(create('over-ons')).rejects.toMatchObject(taken);
    const other = await create('iets-anders');
    await expect(rename(other.id, 'over-ons')).rejects.toMatchObject(taken);
    // A title that gives the slug gets the next free one, not the held one.
    const derived = await invoker.run(useCases.createItem, admin, { document: doc() });
    expect(derived.item.slug).toBe('over-ons-2');
    // An article has its own space.
    expect((await create('over-ons', 'article')).slug).toBe('over-ons');

    await invoker.run(useCases.deleteRedirect, admin, { itemId: item.id, slug: 'over-ons' });
    expect(await olds(item.id)).toEqual([]);
    await expect(resolve('over-ons')).rejects.toMatchObject({ code: 'not_found' });
    expect((await rename(other.id, 'over-ons')).slug).toBe('over-ons');
  });

  it('removes only an old address of that item, with content:write', async () => {
    const item = await create('over-ons');
    await publish(item.id, 'nl');
    await rename(item.id, 'wie-we-zijn');
    const other = await create('elders');
    await expect(
      invoker.run(useCases.deleteRedirect, admin, { itemId: other.id, slug: 'over-ons' })
    ).rejects.toMatchObject({ code: 'not_found' });
    const reader = principal({ capabilities: ['content:read'] });
    await expect(
      invoker.run(useCases.deleteRedirect, reader, { itemId: item.id, slug: 'over-ons' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await olds(item.id)).toEqual(['over-ons']);
  });

  it('forwards nothing to an item that went offline, and to a restricted item as to any other', async () => {
    const item = await create('over-ons');
    await publish(item.id, 'nl');
    await rename(item.id, 'wie-we-zijn');
    await invoker.run(useCases.unpublishItem, admin, { itemId: item.id, locale: 'nl' });
    await expect(resolve('over-ons')).rejects.toMatchObject({ code: 'not_found' });

    await publish(item.id, 'nl');
    const latest = await invoker.run(useCases.getItem, admin, { itemId: item.id });
    const saved = await invoker.run(useCases.updateItem, admin, {
      itemId: item.id,
      baseRevisionId: latest.revision.id,
      document: {
        ...latest.revision.document,
        access: { level: 'members' },
        lead: { nl: 'Voor leden.' },
      } as never,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: saved.revision.id,
      locale: 'nl',
    });
    // Its address serves the teaser, so the old one may point there.
    await expect(resolve('over-ons')).resolves.toEqual({ type: 'page', slug: 'wie-we-zijn' });
  });

  it('is tenant-bound and open to an anonymous reader', async () => {
    const item = await create('over-ons');
    await publish(item.id, 'nl');
    await rename(item.id, 'wie-we-zijn');
    expect(await resolve('over-ons', 'nl', visitor())).toEqual({
      type: 'page',
      slug: 'wie-we-zijn',
    });
    await expect(resolve('over-ons', 'nl', visitor(OTHER_TENANT))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
