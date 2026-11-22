// `refs.existing` (MY-268): a definition points at items the tenant had before it, such as an
// import, by slug. The runner finds them before it makes anything, links to them, never changes
// them, and stops on a still untouched tenant when a slug is missing or names two items.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { adminOf } from '../fixtures.js';
import { MemoryUnitOfWork } from '../memory.js';
import { p, text, to } from './rich.js';
import { seedSite, type SiteDefinition } from './runner.js';

const article = (slug: string, title: string, type: 'article' | 'page' = 'article') => ({
  slug,
  document: {
    type,
    title: { nl: title },
    defaultLocale: 'nl',
    locales: ['nl'],
    blocks: [text({ nl: [p('Al aanwezig.')] })],
  },
});

const site = (slug: string, type?: 'article' | 'page'): SiteDefinition => ({
  slug: 'kopie',
  name: 'Kopie',
  defaultLocale: 'nl',
  locales: ['nl'],
  media: [],
  people: [],
  groups: [],
  sections: [],
  tiers: [],
  forms: [],
  patterns: [],
  campaigns: [],
  items: [
    {
      key: 'home',
      slug: 'home',
      document: (r) => ({
        type: 'page',
        title: { nl: 'Voorpagina' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [
          text({ nl: [p('Lees ', to('het geïmporteerde stuk', r.existing(slug, type)), '.')] }),
        ],
      }),
    },
  ],
});

async function tenant() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = adminOf();
  const { item } = await invoker.run(useCases.createItem, admin, article('verhaal', 'Verhaal'));
  return { invoker, admin, imported: item };
}

const noFiles = async () => new Uint8Array();

describe('refs.existing', () => {
  it('links to an item the tenant already had, leaves it alone, and a second run makes nothing', async () => {
    const { invoker, admin, imported } = await tenant();
    const first = await seedSite(invoker, admin, site('verhaal'), { load: noFiles });
    expect(first.created).toEqual({ item: ['home'] });
    expect(first.refs.existing('verhaal')).toBe(imported.id);

    const home = await invoker.run(useCases.getItem, admin, { itemId: first.refs.item('home') });
    expect(JSON.stringify(home.revision.document.blocks)).toContain(imported.id);
    const { revisions } = await invoker.run(useCases.listRevisions, admin, {
      itemId: imported.id,
    });
    expect(revisions).toHaveLength(1);

    const second = await seedSite(invoker, admin, site('verhaal'), { load: noFiles });
    expect(second.created).toEqual({});
  });

  it('stops before making anything when the slug is missing', async () => {
    const { invoker, admin } = await tenant();
    await expect(seedSite(invoker, admin, site('weg'), { load: noFiles })).rejects.toThrow(
      'the tenant has no item "weg"'
    );
    const { items } = await invoker.run(useCases.listItems, admin, {});
    expect(items.map((i) => i.slug)).toEqual(['verhaal']);
  });

  it('asks for the type when a page and an article share the slug', async () => {
    const { invoker, admin } = await tenant();
    const { item: page } = await invoker.run(
      useCases.createItem,
      admin,
      article('verhaal', 'Verhaal als pagina', 'page')
    );
    await expect(seedSite(invoker, admin, site('verhaal'), { load: noFiles })).rejects.toThrow(
      'both a page and an article'
    );
    const typed = await seedSite(invoker, admin, site('verhaal', 'page'), { load: noFiles });
    expect(typed.refs.existing('verhaal', 'page')).toBe(page.id);
  });
});
