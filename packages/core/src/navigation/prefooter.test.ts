// The pre-footer zone over the memory adapter: a page with the profile `zone`, placed by
// the navigation document and read by `site.prefooter.get` the way the public site shows it.
// packages/db/src/navigation/repository.test.ts holds the Postgres adapter to the published
// targets it reads.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, type Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import type { NavigationDocument } from './model.js';

const heading = (nl: string, en: string) => ({
  type: 'heading',
  version: 1,
  props: { text: { nl, en } },
});

function setup() {
  const uow = new MemoryUnitOfWork({ clock: new FakeClock() });
  const invoker = new Invoker(buildRegistry(), uow);
  const editor = principal({ capabilities: ['content:read', 'content:write', 'content:publish'] });
  const visitor = anonymousPrincipal(TENANT, ['content:read']);
  const run = <K extends keyof typeof useCases>(name: K, input: unknown, p: Principal = editor) =>
    invoker.run(useCases[name] as never, p, input as never) as Promise<any>;

  async function item(
    slug: string,
    doc: Record<string, unknown>,
    publish: string[] = ['nl', 'en']
  ): Promise<{ id: string; revisionId: string }> {
    const { item, revision } = await run('createItem', {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: slug, en: slug },
        blocks: [],
        ...doc,
      },
    });
    for (const locale of publish)
      await run('publishItem', { itemId: item.id, revisionId: revision.id, locale });
    return { id: item.id, revisionId: revision.id };
  }

  const placing = (itemId: string | null, menus: NavigationDocument['menus'] = []) => ({
    menus,
    placements: {
      main: null,
      actions: null,
      footer: [],
      legal: null,
      prefooter: itemId ? { itemId } : null,
    },
  });

  async function place(itemId: string | null, locales = ['nl', 'en']) {
    const head = await run('getNavigation', {});
    const saved = await run('updateNavigation', {
      baseRevisionId: head.revisionId,
      document: placing(itemId),
    });
    for (const locale of locales)
      await run('publishNavigation', { revisionId: saved.revisionId, locale });
    return saved.revisionId as string;
  }

  return { run, item, place, placing, visitor };
}

const refusal = async (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: { code: string; issues: { message: string }[] }) => e
  );

describe('pre-footer zone', () => {
  it('shows the zone the published navigation places, in the locale, until it is replaced', async () => {
    const t = setup();
    const zone = await t.item('blijf-op-de-hoogte', {
      profile: 'zone',
      title: { nl: 'Blijf op de hoogte', en: 'Stay informed' },
      blocks: [heading('Nieuwsbrief', 'Newsletter')],
    });
    expect((await t.run('getPrefooter', { locale: 'nl' }, t.visitor)).zone).toBeNull();

    await t.place(zone.id, ['nl']);
    const { zone: nl } = await t.run('getPrefooter', { locale: 'nl' }, t.visitor);
    expect(nl).toMatchObject({
      itemId: zone.id,
      revisionId: zone.revisionId,
      title: 'Blijf op de hoogte',
      blocks: [{ type: 'heading', props: { text: { nl: 'Nieuwsbrief' } } }],
    });
    // The navigation is not published in en: no zone there.
    expect((await t.run('getPrefooter', { locale: 'en' }, t.visitor)).zone).toBeNull();
    const resolved = await t.run('resolveNavigation', { locale: 'nl' }, t.visitor);
    expect(resolved.prefooter).toEqual({ itemId: zone.id, revisionId: zone.revisionId });

    // Offline in a locale: nothing, never a fallback.
    await t.run('unpublishItem', { itemId: zone.id, locale: 'nl' });
    expect((await t.run('getPrefooter', { locale: 'nl' }, t.visitor)).zone).toBeNull();
  });

  it('shows nothing for a zone that is only a draft in the locale', async () => {
    const t = setup();
    const zone = await t.item('zone', { profile: 'zone' }, []);
    await t.place(zone.id, ['nl']);
    expect((await t.run('getPrefooter', { locale: 'nl' }, t.visitor)).zone).toBeNull();
  });

  it('refuses to place a page or an article, or an item that does not exist', async () => {
    const t = setup();
    const page = await t.item('over-ons', {});
    const e = await refusal(
      t.run('updateNavigation', { baseRevisionId: null, document: t.placing(page.id) })
    );
    expect(e.issues[0]?.message).toBe('site.navigation.prefooter.not-a-zone');
    const gone = await refusal(
      t.run('updateNavigation', {
        baseRevisionId: null,
        document: t.placing('00000000-0000-4000-8000-00000000dead'),
      })
    );
    expect(gone.issues[0]?.message).toBe('site.navigation.prefooter.not-a-zone');
  });

  it('keeps a placed zone out of the trash until another is placed and published', async () => {
    const t = setup();
    const zone = await t.item('zone', { profile: 'zone' });
    await t.place(zone.id, ['nl']);
    const e = await refusal(t.run('deleteItem', { itemId: zone.id }));
    expect(e).toMatchObject({ code: 'conflict' });
    expect(e.issues[0]?.message).toBe('content.delete.prefooter');
    // The draft drops it; the published revision still places it.
    const head = await t.run('getNavigation', {});
    await t.run('updateNavigation', { baseRevisionId: head.revisionId, document: t.placing(null) });
    expect((await refusal(t.run('deleteItem', { itemId: zone.id }))).code).toBe('conflict');
    await t.place(null, ['nl']);
    await t.run('deleteItem', { itemId: zone.id });
  });

  it('has no address, card, sitemap row, search hit or menu link of its own', async () => {
    const t = setup();
    const zone = await t.item('zone', {
      profile: 'zone',
      title: { nl: 'Zoekwoord', en: 'Keyword' },
    });
    await expect(
      t.run('getPublished', { type: 'page', slug: 'zone', locale: 'nl' }, t.visitor)
    ).rejects.toMatchObject({ code: 'not_found' });
    const listed = await t.run('listPublished', {}, t.visitor);
    expect(listed.items.map((r: { id: string }) => r.id)).not.toContain(zone.id);
    const overview = await t.run(
      'getOverview',
      { props: { source: 'page', limit: '6' }, locale: 'nl' },
      t.visitor
    );
    expect(overview.entries.map((r: { id: string }) => r.id)).not.toContain(zone.id);
    const found = await t.run('findPublished', { q: 'zoekwoord', locale: 'nl' }, t.visitor);
    expect(found.items).toEqual([]);

    const menu = {
      id: 'main',
      name: 'Hoofdmenu',
      nodes: [
        { id: 'z', kind: 'link' as const, target: { kind: 'content' as const, itemId: zone.id } },
      ],
    };
    const doc = {
      ...t.placing(null, [menu]),
      placements: { ...t.placing(null).placements, main: { menuId: 'main', bar: ['z'] } },
    };
    const saved = await t.run('updateNavigation', { baseRevisionId: null, document: doc });
    const check = await t.run('checkNavigation', { locale: 'nl', revisionId: saved.revisionId });
    expect(check.preview.main.nodes).toEqual([]);
    expect(check.problems).toContainEqual(
      expect.objectContaining({ nodeId: 'z', code: 'target-unavailable' })
    );
  });

  it('carries prefooter: false on the published item that switches the zone off', async () => {
    const t = setup();
    await t.item('petitie', { prefooter: false });
    await t.item('gewoon', {});
    const off = await t.run('getPublished', { type: 'page', slug: 'petitie' }, t.visitor);
    const on = await t.run('getPublished', { type: 'page', slug: 'gewoon' }, t.visitor);
    expect(off.prefooter).toBe(false);
    expect(on).not.toHaveProperty('prefooter');
  });
});
