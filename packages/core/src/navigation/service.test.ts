// Site navigation over the memory adapter (ADR 036): the fixtures `nav-basic`, `nav-labels`,
// `nav-offline` and `nav-concurrency` through the registry, so capabilities, merge, publication,
// references and public resolution are tested where every front calls them.
// packages/db/src/navigation/repository.test.ts holds the Postgres adapter to the same behaviour.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, type Principal } from '../principal.js';
import {
  FakeClock,
  MemoryUnitOfWork,
  TENANT,
  navBasic,
  navConcurrency,
  navLabels,
  navOffline,
  principal,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { exampleId } from '../util/ids.js';
import { EMPTY_NAVIGATION, type NavigationDocument } from './model.js';

const OTHER = exampleId(0xbbbb);

function setup() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const editor = principal({ capabilities: ['content:read', 'content:write', 'content:publish'] });
  const writer = principal({ capabilities: ['content:read', 'content:write'] });
  const visitor = anonymousPrincipal(TENANT, ['content:read']);
  const run = <K extends keyof typeof useCases>(name: K, input: unknown, p: Principal = editor) =>
    invoker.run(useCases[name] as never, p, input as never) as Promise<any>;

  async function page(
    slug: string,
    doc: { title: Record<string, string>; locales?: string[]; [k: string]: unknown },
    publish: string[] = doc.locales ?? ['nl'],
    p: Principal = editor
  ) {
    const locales = doc.locales ?? ['nl'];
    const { item, revision } = await run(
      'createItem',
      { slug, document: { type: 'page', defaultLocale: 'nl', blocks: [], ...doc, locales } },
      p
    );
    for (const locale of publish)
      await run('publishItem', { itemId: item.id, revisionId: revision.id, locale }, p);
    return { id: item.id as string, revisionId: revision.id as string };
  }

  async function save(document: NavigationDocument, baseRevisionId: string | null = null) {
    return run('updateNavigation', { baseRevisionId, document });
  }

  async function publishAll(revisionId: string, locales = ['nl', 'en']) {
    for (const locale of locales) await run('publishNavigation', { revisionId, locale });
  }

  return { clock, invoker, editor, writer, visitor, run, page, save, publishAll };
}

const refusal = async (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: { code: string; issues: { message: string; params?: Record<string, string> }[] }) => e
  );

async function basic(t: ReturnType<typeof setup>) {
  const two = { locales: ['nl', 'en'] };
  const about = await t.page('over-ons', { title: { nl: 'Over ons', en: 'About us' }, ...two });
  const news = await t.page('nieuws', { title: { nl: 'Nieuws', en: 'News' }, ...two });
  const campaign = await t.page('teken', { title: { nl: 'Teken', en: 'Sign' }, ...two });
  const privacy = await t.page('privacy', { title: { nl: 'Privacy', en: 'Privacy' }, ...two });
  return { about: about.id, news: news.id, campaign: campaign.id, privacy: privacy.id };
}

describe('nav-basic', () => {
  it('is a draft until a locale is published, then resolves per locale', async () => {
    const t = setup();
    const ids = await basic(t);
    const saved = await t.save(navBasic(ids));
    expect(saved.merged).toBe(false);
    expect(saved.publication).toEqual([]);
    expect(await t.run('resolveNavigation', { locale: 'nl' }, t.visitor)).toMatchObject({
      revisionId: null,
      main: null,
    });

    await t.publishAll(saved.revisionId);
    const nl = await t.run('resolveNavigation', { locale: 'nl' }, t.visitor);
    expect(nl.main.bar).toEqual(['about', 'donate', 'themes']);
    expect(nl.main.nodes.map((n: { label: string | null }) => n.label)).toEqual([
      'Over ons',
      'Doneren',
      null,
      'Thema’s',
    ]);
    expect(nl.main.nodes[0].target).toEqual({
      kind: 'content',
      itemId: ids.about,
      type: 'page',
      slug: 'over-ons',
      locale: 'nl',
    });
    expect(nl.main.nodes[3].children.map((c: { label: string }) => c.label)).toEqual([
      'Nieuws',
      'Partner',
    ]);
    expect(nl.actions.map((a: { label: string }) => a.label)).toEqual(['Geef nu', 'Teken']);
    expect(nl.footer.map((f: { title: string | null }) => f.title)).toEqual(['Over', null]);
    expect(nl.legal.nodes[0].label).toBe('Privacy');
    const en = await t.run('resolveNavigation', { locale: 'en' }, t.visitor);
    expect(en.main.nodes[0].label).toBe('About us');
    expect(en.main.nodes[0].target.locale).toBe('en');
  });

  it('splits writing from publishing: content:write saves and restores, content:publish publishes', async () => {
    const t = setup();
    const ids = await basic(t);
    const first = await t.run(
      'updateNavigation',
      { baseRevisionId: null, document: navBasic(ids) },
      t.writer
    );
    expect(
      (
        await refusal(
          t.run('publishNavigation', { revisionId: first.revisionId, locale: 'nl' }, t.writer)
        )
      ).code
    ).toBe('forbidden');
    await t.run('publishNavigation', { revisionId: first.revisionId, locale: 'nl' });
    expect((await refusal(t.run('unpublishNavigation', { locale: 'nl' }, t.writer))).code).toBe(
      'forbidden'
    );
    const second = await t.run(
      'updateNavigation',
      {
        baseRevisionId: first.revisionId,
        document: { ...navBasic(ids), placements: { ...navBasic(ids).placements, actions: null } },
      },
      t.writer
    );
    const restored = await t.run(
      'restoreNavigation',
      { revisionId: first.revisionId, baseRevisionId: second.revisionId },
      t.writer
    );
    expect(restored.revisions[0]).toMatchObject({ restoredFrom: first.revisionId });
    // A restore is a draft: the published locale still points at the first revision.
    expect(restored.publication).toEqual([
      expect.objectContaining({ locale: 'nl', revisionId: first.revisionId }),
    ]);
    expect((await refusal(t.run('getNavigation', {}, t.visitor))).code).toBe('forbidden');
  });

  it('publishes one locale without touching another, and takes one offline', async () => {
    const t = setup();
    const ids = await basic(t);
    const { revisionId } = await t.save(navBasic(ids));
    await t.publishAll(revisionId);
    await t.run('unpublishNavigation', { locale: 'en' });
    expect((await t.run('resolveNavigation', { locale: 'en' }, t.visitor)).main).toBeNull();
    expect((await t.run('resolveNavigation', { locale: 'nl' }, t.visitor)).main).not.toBeNull();
    expect((await refusal(t.run('unpublishNavigation', { locale: 'en' }))).code).toBe('not_found');
  });

  it('refuses to publish a group or URL link without a label in that locale', async () => {
    const t = setup();
    const ids = await basic(t);
    const doc = navBasic(ids);
    const group = doc.menus[0]!.nodes[3]!;
    if (group.kind === 'group') group.label = { nl: 'Thema’s' };
    const { revisionId } = await t.save(doc);
    await t.run('publishNavigation', { revisionId, locale: 'nl' });
    const e = await refusal(t.run('publishNavigation', { revisionId, locale: 'en' }));
    expect(e.code).toBe('invalid_input');
    expect(e.issues).toEqual([
      expect.objectContaining({
        message: 'site.navigation.label-missing',
        params: { menuId: 'main', nodeId: 'themes', locale: 'en' },
      }),
    ]);
  });

  it('refuses a new link to an item that does not exist, or is in the trash', async () => {
    const t = setup();
    const ids = await basic(t);
    await t.run('deleteItem', { itemId: ids.privacy });
    const e = await refusal(t.save(navBasic(ids)));
    expect(e.issues).toEqual([
      expect.objectContaining({
        message: 'site.navigation.target.unknown',
        params: { itemId: ids.privacy },
      }),
    ]);
  });
});

describe('references (ADR 036 rule 9)', () => {
  it('refuse deleting an item the draft or a published revision links to, naming the menus', async () => {
    const t = setup();
    const ids = await basic(t);
    const first = await t.save(navBasic(ids));
    await t.publishAll(first.revisionId, ['nl']);
    const e = await refusal(t.run('deleteItem', { itemId: ids.privacy }));
    expect(e.code).toBe('conflict');
    expect(e.issues[0]).toMatchObject({
      message: 'content.delete.in-navigation',
      params: { count: '1', menus: 'Juridisch' },
    });

    // The draft drops the legal menu's link; the published revision still has it.
    const doc = navBasic(ids);
    doc.menus[4]!.nodes = [];
    const second = await t.save(doc, first.revisionId);
    expect((await refusal(t.run('deleteItem', { itemId: ids.privacy }))).code).toBe('conflict');

    // Published too: only older revisions point at it now, which do not block.
    await t.publishAll(second.revisionId, ['nl']);
    await t.run('deleteItem', { itemId: ids.privacy });
  });

  it('refuse removing a menu that a published placement uses', async () => {
    const t = setup();
    const ids = await basic(t);
    const first = await t.save(navBasic(ids));
    await t.publishAll(first.revisionId, ['nl']);
    const doc = navBasic(ids);
    doc.menus = doc.menus.filter((m) => m.id !== 'legal');
    doc.placements.legal = null;
    const e = await refusal(t.save(doc, first.revisionId));
    expect(e.issues).toEqual([
      expect.objectContaining({
        message: 'site.navigation.menu.published',
        params: { menuId: 'legal' },
      }),
    ]);
  });
});

describe('nav-labels', () => {
  it('takes the own label, else the published featured title, else the published title, in one locale', async () => {
    const t = setup();
    const own = await t.page('eigen', { title: { nl: 'Paginatitel' } });
    const featured = await t.page('uitgelicht', {
      title: { nl: 'Lange titel', en: 'Long title' },
      featured: { title: { nl: 'Kort' } },
      locales: ['nl', 'en'],
    });
    const title = await t.page('titel', { title: { nl: 'Gepubliceerd' } });
    // A draft with another title does not reach the menu until it is published.
    await t.run('updateItem', {
      itemId: title.id,
      baseRevisionId: title.revisionId,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Concept' },
        blocks: [],
      },
    });
    const { revisionId } = await t.save(
      navLabels({ own: own.id, featured: featured.id, title: title.id })
    );
    await t.publishAll(revisionId);
    const nl = await t.run('resolveNavigation', { locale: 'nl' }, t.visitor);
    expect(nl.main.nodes.map((n: { label: string }) => n.label)).toEqual([
      'Eigen tekst',
      'Kort',
      'Gepubliceerd',
    ]);
    // en: no own label and no en publication for two targets, so only the featured item shows,
    // with its en title (no featured title in en): never another locale's text.
    const en = await t.run('resolveNavigation', { locale: 'en' }, t.visitor);
    expect(en.main.nodes.map((n: { label: string }) => n.label)).toEqual(['Long title']);
    // The editor's read says the same per node, with where the text comes from and why not.
    const facts = async (locale: string) =>
      (await t.run('checkNavigation', { locale }, t.writer)).nodes.map(
        (n: { label: string | null; source: string | null; target: string | null }) =>
          [n.label, n.source, n.target].join(' | ')
      );
    expect(await facts('nl')).toEqual([
      'Eigen tekst | own | ok',
      'Kort | featured | ok',
      'Gepubliceerd | title | ok',
    ]);
    expect(await facts('en')).toEqual([
      ' |  | unpublished',
      'Long title | title | ok',
      ' |  | unpublished',
    ]);
    // A draft's check is not a public read.
    await expect(t.run('checkNavigation', { locale: 'nl' }, t.visitor)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('checks groups, addresses, system pages and a target that is gone, in unplaced menus too', async () => {
    const t = setup();
    const page = await t.page('verdwenen', { title: { nl: 'Verdwenen' } });
    const { revisionId } = await t.save({
      menus: [
        {
          id: 'loose',
          name: 'Not placed',
          nodes: [
            { id: 'g', kind: 'group', label: { nl: 'Groep' }, children: [] },
            { id: 'u', kind: 'link', target: { kind: 'url', href: '/elders' } },
            { id: 's', kind: 'link', target: { kind: 'system', page: 'search' } },
            { id: 'c', kind: 'link', target: { kind: 'content', itemId: page.id } },
          ],
        },
      ],
      placements: { main: null, actions: null, footer: [], legal: null },
    });
    await t.run('unpublishItem', { itemId: page.id, locale: 'nl' });
    const { nodes, revisionId: checked } = await t.run('checkNavigation', { locale: 'nl' });
    expect(checked).toBe(revisionId);
    expect(nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['g', 'u', 's', 'c']);
    expect(nodes.map((n: { source: string | null }) => n.source)).toEqual([
      'own',
      null,
      'system',
      null,
    ]);
    expect(nodes[3].target).toBe('unpublished');
    expect((await t.run('checkNavigation', { locale: 'en' })).nodes[0].label).toBeNull();
    await expect(
      t.run('checkNavigation', { locale: 'nl', revisionId: OTHER })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads an older revision by id, and none of another site', async () => {
    const t = setup();
    const menu = (name: string): NavigationDocument => ({
      ...EMPTY_NAVIGATION,
      menus: [{ id: 'm', name, nodes: [] }],
    });
    const first = await t.save(menu('First'));
    const second = await t.save(menu('Second'), first.revisionId);
    const old = await t.run('getNavigation', { revisionId: first.revisionId }, t.writer);
    expect(old.revisionId).toBe(first.revisionId);
    expect(old.document.menus[0].name).toBe('First');
    const latest = await t.run('getNavigation', {});
    expect([latest.revisionId, latest.document.menus[0].name]).toEqual([
      second.revisionId,
      'Second',
    ]);
    await expect(t.run('getNavigation', { revisionId: OTHER })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('checks nothing before the first save', async () => {
    const t = setup();
    expect(await t.run('checkNavigation', { locale: 'nl' })).toEqual({
      revisionId: null,
      nodes: [],
    });
  });
});

describe('nav-offline', () => {
  it('renders nothing for what is not public in the locale, and keeps a labelled branch as a group', async () => {
    const t = setup();
    const two = { locales: ['nl', 'en'] };
    const parent = await t.page('campagnes', {
      title: { nl: 'Campagnes', en: 'Campaigns' },
      ...two,
    });
    const child = await t.page('actie', { title: { nl: 'Actie', en: 'Action' }, ...two });
    const lonely = await t.page('alleen', { title: { nl: 'Alleen', en: 'Alone' }, ...two });
    const anchored = await t.page('anker', { title: { nl: 'Anker', en: 'Anchor' }, ...two });
    const trashed = await t.page('verdwenen', { title: { nl: 'Weg', en: 'Gone' }, ...two });
    const restricted = await t.page('leden', {
      title: { nl: 'Leden', en: 'Members' },
      access: { level: 'members' },
      ...two,
    });
    const foreign = await t.page(
      'elders',
      { title: { nl: 'Elders' } },
      ['nl'],
      principal({ tenantId: OTHER })
    );
    const ids = {
      parent: parent.id,
      child: child.id,
      lonely: lonely.id,
      anchored: anchored.id,
      trashed: trashed.id,
      foreign: foreign.id,
      restricted: restricted.id,
    };
    // The other tenant's item is unknown here, so a new link to it is refused like any unknown id.
    expect((await refusal(t.save(navOffline(ids)))).issues[0]).toMatchObject({
      message: 'site.navigation.target.unknown',
      params: { itemId: foreign.id },
    });
    const { foreign: _, ...local } = ids;
    const doc = navOffline({ ...local, foreign: trashed.id });
    const { revisionId } = await t.save(doc);
    await t.publishAll(revisionId);

    for (const p of [parent, lonely])
      for (const locale of ['nl', 'en']) await t.run('unpublishItem', { itemId: p.id, locale });
    // Trashing needs the menu reference gone: the draft drops it, both locales publish it.
    const without = structuredClone(doc);
    without.menus[0]!.nodes = without.menus[0]!.nodes.filter(
      (n) => n.id !== 'trashed' && n.id !== 'foreign'
    );
    const next = await t.save(without, revisionId);
    await t.publishAll(next.revisionId);
    await t.run('deleteItem', { itemId: trashed.id });
    // The original revision, restored: its trashed target is kept, and shows nothing.
    const back = await t.run('restoreNavigation', { revisionId, baseRevisionId: next.revisionId });
    const e = await refusal(
      t.run('publishNavigation', { revisionId: back.revisionId, locale: 'nl' })
    );
    expect(e.issues.map((i) => i.message)).toEqual([
      'site.navigation.target.unknown',
      'site.navigation.target.unknown',
    ]);

    const nl = await t.run('resolveNavigation', { locale: 'nl' }, t.visitor);
    expect(nl.main.nodes).toEqual([
      // Own label in nl: the offline parent becomes a group of its reachable children.
      {
        id: 'parent',
        kind: 'group',
        label: 'Campagnes',
        children: [
          expect.objectContaining({ id: 'child', label: 'Actie' }),
          expect.objectContaining({ id: 'child-url', label: 'Archief' }),
        ],
      },
      // The group's only child went offline: an empty group renders nothing. The anchor that
      // no longer exists falls back to the page; the restricted item is not shown.
      expect.objectContaining({
        id: 'anchored',
        label: 'Anker',
        target: expect.not.objectContaining({ anchor: expect.anything() }),
      }),
    ]);
    // No own label in en: the whole branch goes.
    const en = await t.run('resolveNavigation', { locale: 'en' }, t.visitor);
    expect(en.main.nodes.map((n: { id: string }) => n.id)).toEqual(['anchored']);

    const published = await t.run('publishNavigation', {
      revisionId: next.revisionId,
      locale: 'en',
    });
    expect(published.problems).toEqual(
      expect.arrayContaining([
        {
          menuId: 'main',
          nodeId: 'parent',
          code: 'children-unreachable',
          children: ['child', 'child-url'],
        },
        { menuId: 'main', nodeId: 'anchored', code: 'anchor-missing' },
        { menuId: 'main', nodeId: 'restricted', code: 'target-unavailable' },
        { menuId: 'main', nodeId: 'lonely', code: 'target-unavailable' },
      ])
    );
  });
});

describe('nav-concurrency', () => {
  async function twoSaves(change: (a: NavigationDocument, b: NavigationDocument) => void) {
    const t = setup();
    const base = await t.save(navConcurrency());
    const mine = navConcurrency();
    const theirs = navConcurrency();
    change(mine, theirs);
    const first = await t.save(theirs, base.revisionId);
    return { t, first, second: t.save(mine, base.revisionId) };
  }

  it('merges saves on one base that change different menus', async () => {
    const { second } = await twoSaves((mine, theirs) => {
      mine.menus[1]!.nodes.reverse();
      theirs.menus[0]!.nodes.push({
        id: 'd',
        kind: 'link',
        label: { nl: 'D' },
        target: { kind: 'url', href: '/d' },
      });
    });
    const saved = await second;
    expect(saved.merged).toBe(true);
    expect(saved.document.menus[0].nodes.map((n: { id: string }) => n.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(saved.document.menus[1].nodes.map((n: { id: string }) => n.id)).toEqual(['f2', 'f1']);
    expect(saved.revisions[0]).toMatchObject({ merged: true });
  });

  it('merges different nodes of one menu, and conflicts on its order or one label', async () => {
    const labels = await twoSaves((mine, theirs) => {
      mine.menus[0]!.nodes[0]!.label = { nl: 'A mijn' };
      theirs.menus[0]!.nodes[1]!.label = { nl: 'B hun' };
    });
    expect((await labels.second).merged).toBe(true);

    const order = await twoSaves((mine, theirs) => {
      mine.menus[0]!.nodes.reverse();
      theirs.menus[0]!.nodes.push(theirs.menus[0]!.nodes.shift()!);
    });
    const e = await refusal(order.second);
    expect(e.code).toBe('conflict');
    expect(e.issues.map((i) => (i as { path?: string }).path)).toContain(
      'document.menus[id=main].nodes#order'
    );

    const label = await twoSaves((mine, theirs) => {
      mine.menus[0]!.nodes[0]!.label = { nl: 'Mijn' };
      theirs.menus[0]!.nodes[0]!.label = { nl: 'Hun' };
    });
    expect((await refusal(label.second)).code).toBe('conflict');
  });

  it('refuses a save on a base it cannot merge from', async () => {
    const t = setup();
    await t.save(navConcurrency());
    expect((await refusal(t.save(navConcurrency(), null))).code).toBe('conflict');
  });

  it('serialises a delete with a save that adds a reference to the same item', async () => {
    const t = setup();
    const target = await t.page('doel', { title: { nl: 'Doel' } });
    const base = await t.save(navConcurrency());
    const doc = navConcurrency();
    doc.menus[0]!.nodes.push({
      id: 'doel',
      kind: 'link',
      target: { kind: 'content', itemId: target.id },
    });
    const results = await Promise.allSettled([
      t.save(doc, base.revisionId),
      t.run('deleteItem', { itemId: target.id }),
    ]);
    // Exactly one wins: the save first makes the delete refuse; the delete first makes the save refuse.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
