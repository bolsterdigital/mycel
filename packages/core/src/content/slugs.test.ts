// The start slug of a new item follows its title until the item has been live (editor trial
// P185-79), and nothing else ever moves a slug on save.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { isStartSlug, startSlug } from './slugs.js';

const UUID = '01900000-0000-7000-8000-0000000000aa';
const STAND_IN = '(geen titel)';

const doc = (nl: string, type: 'page' | 'article' = 'page') => ({
  type,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl, en: 'English stays' },
  blocks: [],
});

describe('the start slug', () => {
  it('is recognised for its own type only', () => {
    expect(startSlug('page', UUID)).toBe(`page-${UUID}`);
    expect(isStartSlug('page', `page-${UUID}`)).toBe(true);
    expect(isStartSlug('article', `page-${UUID}`)).toBe(false);
    expect(isStartSlug('page', `page-${UUID}-2`)).toBe(false);
    expect(isStartSlug('page', 'page-over-ons')).toBe(false);
  });
});

describe('a save that gives a new item its title', () => {
  let invoker: Invoker;
  let admin: Principal;
  let n: number;

  beforeEach(() => {
    invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork({ clock: new FakeClock() }));
    admin = systemPrincipal(TENANT, 'test');
    n = 0;
  });

  const fresh = (type: 'page' | 'article' = 'page', slug?: string) =>
    invoker.run(useCases.createItem, admin, {
      slug: slug ?? startSlug(type, UUID.replace(/aa$/, (++n).toString(16).padStart(2, '0'))),
      document: doc(STAND_IN, type),
    });
  const save = (itemId: string, baseRevisionId: string, title: string, type?: 'article') =>
    invoker.run(useCases.updateItem, admin, {
      itemId,
      baseRevisionId,
      document: doc(title, type),
    });

  it('moves the start slug to the title once, and the revision chain stays whole', async () => {
    const { item, revision } = await fresh();
    const first = await save(item.id, revision.id, 'Dit is de titel');
    expect(first.item.slug).toBe('dit-is-de-titel');
    expect(first.item.latestRevisionId).toBe(first.revision.id);
    const found = await invoker.run(useCases.listItems, admin, { slug: 'dit-is-de-titel' });
    expect(found.items.map((i) => i.id)).toEqual([item.id]);
    // From now on the slug is the item's own: a new title leaves it, and the next base is the
    // revision this save returned.
    const second = await save(item.id, first.revision.id, 'Een andere titel');
    expect(second.item.slug).toBe('dit-is-de-titel');
    const old = await invoker.run(useCases.getItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
    });
    expect(old.revision).toEqual(revision);
  });

  it('keeps the start slug while the title is the stand-in or gives no slug', async () => {
    const { item, revision } = await fresh();
    const kept = await save(item.id, revision.id, STAND_IN);
    expect(kept.item.slug).toBe(item.slug);
    const punct = await save(item.id, kept.revision.id, '!!!');
    expect(punct.item.slug).toBe(item.slug);
    // A later real title still counts.
    expect((await save(item.id, punct.revision.id, 'Toch een titel')).item.slug).toBe(
      'toch-een-titel'
    );
  });

  it('never moves a slug the item was given or that an editor chose', async () => {
    const given = await fresh('page', 'over-ons');
    expect((await save(given.item.id, given.revision.id, 'Wie we zijn')).item.slug).toBe(
      'over-ons'
    );
    const chosen = await fresh();
    await invoker.run(useCases.updateSlug, admin, { itemId: chosen.item.id, slug: 'eigen-adres' });
    expect((await save(chosen.item.id, chosen.revision.id, 'Wie we zijn')).item.slug).toBe(
      'eigen-adres'
    );
  });

  it('keeps the start slug once any locale has been live, also after it went offline', async () => {
    const { item, revision } = await fresh();
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'en',
    });
    await invoker.run(useCases.unpublishItem, admin, { itemId: item.id, locale: 'en' });
    expect((await save(item.id, revision.id, 'Dit is de titel')).item.slug).toBe(item.slug);
  });

  it('takes the next free slug on a collision or a reserved page name, per type', async () => {
    await fresh('page', 'dit-is-de-titel');
    const page = await fresh();
    expect((await save(page.item.id, page.revision.id, 'Dit is de titel')).item.slug).toBe(
      'dit-is-de-titel-2'
    );
    const reserved = await fresh();
    expect((await save(reserved.item.id, reserved.revision.id, 'Admin')).item.slug).toBe('admin-2');
    // Articles have their own space.
    const article = await fresh('article');
    expect(
      (await save(article.item.id, article.revision.id, 'Dit is de titel', 'article')).item.slug
    ).toBe('dit-is-de-titel');
  });
});
