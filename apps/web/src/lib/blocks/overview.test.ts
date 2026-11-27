// What the renderer makes of an overview: the list is part of the render model, so the
// public page's ETag digest (public-page.ts hashes the model) moves when an article joins the
// list or one is republished, without a new revision of the host page. Only a block with an
// archive follows `?p=`, and its page links point at the host's own path. Which items a list
// holds is proven over both adapters in packages/db/src/adapter-rules.test.ts; the agenda below
// runs the real source over the in-memory unit of work so its clock can pass an event's end.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import {
  anonymousPrincipal,
  Block,
  BLOCK_DEFINITIONS,
  buildRegistry,
  Invoker,
  projectBlock,
  systemPrincipal,
  useCases,
  type Overview,
} from '@mycel/core';
import { FakeClock, MemoryUnitOfWork } from '@mycel/core/testing';
import { resolveDocument, runtimeSource, type ResolveSource } from './resolve.js';
import Blocks from './Blocks.svelte';
import type { CardPlaceholder } from './model.js';

const block = (id: string, props: Record<string, unknown>) =>
  Block.parse({ id, type: 'overview', version: BLOCK_DEFINITIONS.overview.version, props });

const entry = (n: number, revision = 0) => ({
  id: `01900000-0000-7000-8000-00000000e0${n}${revision}`,
  type: 'article' as const,
  slug: `bericht-${n}`,
  revisionId: `01900000-0000-7000-8000-00000000e1${n}${revision}`,
  date: `2026-11-0${n}T10:00:00.000Z`,
  title: `Bericht ${n}`,
  summary: null,
  imageId: null,
  event: null,
  pinned: false,
  restricted: false,
});

async function model(list: (page: number) => Overview, blocks: Block[], page = 1) {
  const pages: number[] = [];
  const source: ResolveSource = {
    form: async () => null,
    media: async () => null,
    itemPath: async () => null,
    overview: async (_props, _locale, p) => (pages.push(p), list(p)),
  };
  const resolved = await resolveDocument(
    source,
    { locale: 'nl', title: 'Nieuws', blocks: blocks.map((b) => projectBlock(b, 'nl')) },
    { base: '', fallbackLocale: 'nl', path: '/nieuws', page, timeZone: 'Europe/Amsterdam' }
  );
  return { resolved, pages };
}

describe('an overview in the render model', () => {
  const archive = block('a', { archive: true, limit: '2' });

  it('changes when an article joins the list or is republished', async () => {
    const before = await model(() => ({ entries: [entry(1)], older: false }), [archive]);
    const joined = await model(() => ({ entries: [entry(2), entry(1)], older: false }), [archive]);
    const republished = await model(() => ({ entries: [entry(1, 1)], older: false }), [archive]);
    expect(JSON.stringify(joined.resolved)).not.toBe(JSON.stringify(before.resolved));
    expect(JSON.stringify(republished.resolved)).not.toBe(JSON.stringify(before.resolved));
  });

  it('links older and newer pages on the host path, only with an archive', async () => {
    const plain = block('b', { limit: '2' });
    const { resolved, pages } = await model(
      () => ({ entries: [entry(1)], older: true }),
      [archive, plain],
      2
    );
    expect(pages).toEqual([2, 1]);
    const [paged, fixed] = resolved.blocks;
    expect(paged).toMatchObject({ type: 'overview', older: '/nieuws?p=3', newer: '/nieuws' });
    expect(fixed).toMatchObject({ type: 'overview', older: null, newer: null });
  });

  it('dates an entry in the site time zone', async () => {
    const late = { ...entry(1), date: '2026-11-01T23:30:00.000Z' };
    const { resolved } = await model(() => ({ entries: [late], older: false }), [archive]);
    expect(resolved.blocks[0]).toMatchObject({
      entries: [{ date: { iso: '2026-11-02', label: '2 november 2026' } }],
    });
  });

  it('serves a brief excerpt for page cards while keeping the authored summary in the model', async () => {
    const excerpt = 'Dit is een langere samenvatting. '.repeat(4).trim();
    const summary = `${excerpt} Wijkraadsverkiezingen horen ook bij dit verhaal.`;
    const selection = block('selection', { source: 'selection' });
    const { resolved } = await model(
      () => ({
        entries: [
          { ...entry(1), type: 'page', summary },
          { ...entry(2), type: 'page', summary: 'Een korte samenvatting.' },
        ],
        older: false,
      }),
      [selection]
    );
    const html = render(Blocks, { props: { model: resolved } }).body;
    expect(resolved.blocks[0]).toMatchObject({
      entries: [{ summary }, { summary: 'Een korte samenvatting.' }],
    });
    // The card ends on the sentences that fit (article-card.test.ts holds the cutting rules).
    expect(html).toContain(
      `<p class="overview-excerpt">${Array(3).fill('Dit is een langere samenvatting.').join(' ')}</p>`
    );
    expect(html).toContain('<p class="overview-excerpt">Een korte samenvatting.</p>');
    expect(html).not.toContain('Wijkraadsverkiezingen');
  });
});

describe('an agenda in the render model', () => {
  const TENANT = '01900000-0000-7000-8000-00000000aaaa';

  it('moves an event to past once the clock passes its end, which changes the page', async () => {
    // 12:00 UTC is 14:00 on the site's clock (Europe/Amsterdam, the default).
    const clock = new FakeClock(new Date('2026-10-21T12:00:00.000Z'));
    const uow = new MemoryUnitOfWork({ clock });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'test');
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'buurtavond',
      document: {
        type: 'page',
        profile: 'event',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Buurtavond' },
        event: {
          startsAt: '2026-10-21T13:00',
          endsAt: '2026-10-21T15:00',
          location: { nl: 'Buurthuis' },
        },
        blocks: [],
      },
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
    const source = runtimeSource({
      invoker,
      uow,
      reader: anonymousPrincipal(TENANT, ['content:read', 'forms:read', 'media:read']),
      defaultLocale: 'nl',
    });
    const agenda = [
      block('komend', { source: 'event' }),
      block('geweest', { source: 'event', when: 'past', layout: 'list' }),
    ];
    const read = async () => {
      const { blocks } = await resolveDocument(
        source,
        { locale: 'nl', title: 'Agenda', blocks: agenda.map((b) => projectBlock(b, 'nl')) },
        { base: '', fallbackLocale: 'nl', path: '/agenda', timeZone: 'Europe/Amsterdam' }
      );
      return blocks as Extract<(typeof blocks)[number], { type: 'overview' }>[];
    };

    const running = await read();
    expect(running.map((b) => b.entries.map((e) => e.href))).toEqual([['/buurtavond'], []]);
    expect(running[0]!.entries[0]).toMatchObject({
      date: { iso: '2026-10-21T13:00', label: 'woensdag 21 oktober 2026, 13:00–15:00' },
      place: 'Buurthuis',
    });

    clock.advance(2 * 3_600_000);
    const over = await read();
    expect(over.map((b) => b.entries.map((e) => e.href))).toEqual([[], ['/buurtavond']]);
    // The public page's ETag digest hashes this model: a conditional GET after the turn is no 304.
    expect(JSON.stringify(over)).not.toBe(JSON.stringify(running));
  });
});

// MY-277: a card whose item has no image along its chain shows the site's placeholder in the
// image area, decorative; without a site (a fixture) it has no image area, as before.
describe('a card without an image', () => {
  const cards = (placeholder?: CardPlaceholder) =>
    resolveDocument(
      {
        form: async () => null,
        media: async () => null,
        itemPath: async () => null,
        overview: async () => ({ entries: [entry(1)], older: false }),
      },
      { locale: 'nl', title: 'Nieuws', blocks: [projectBlock(block('p', {}), 'nl')] },
      { base: '', fallbackLocale: 'nl', ...(placeholder ? { placeholder } : {}) }
    ).then((model) => render(Blocks, { props: { model } }).body);

  it("shows the site's initial, or its logo, hidden from assistive technology", async () => {
    const initial = await cards({ logo: null, initial: 'O' });
    expect(initial.replace(/<!--[^>]*-->/g, '')).toContain(
      '<div class="campaign-card-image card-placeholder" aria-hidden="true"><span>O</span></div>'
    );
    const logo = await cards({
      logo: { src: '/_brand/logo-3.webp', width: 200, height: 80 },
      initial: 'O',
    });
    expect(logo).toContain('src="/_brand/logo-3.webp"');
    expect(logo.replace(/<!--[^>]*-->/g, '')).toMatch(
      /card-placeholder[^>]*aria-hidden="true"><img[^>]*alt=""/
    );
  });

  it('has no image area without a placeholder', async () => {
    expect(await cards()).not.toContain('campaign-card-image');
  });
});
