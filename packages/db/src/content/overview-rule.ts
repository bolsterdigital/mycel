// The overview scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedOverview`). In a file of its own
// because the suite is at its size ceiling; it builds its own documents.

import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { useCases, wallClock, type Invoker, type Principal } from '@mycel/core';

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

const article = <T extends Record<string, unknown>>(slug: string, over: T = {} as T) => ({
  type: 'article' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: `Titel ${slug}`, en: `Title ${slug}` },
  blocks: [] as never[],
  ...over,
});

/**
 * An overview block's list (`content.overview.get`): published revisions in the asked locale
 * only, filtered by type, section and every tag, ordered by first publication with the item id
 * breaking a tie; pins on top in the editor's order, a pin not published in this locale dropping
 * out; page 2 continuing page 1. A restricted item is a card marked `restricted` with its title
 * and lead, never its body. A draft after publication, an unpublished or other locale, a
 * scheduled pin, the trash and another tenant never appear, and a republish does not move an
 * item. A fixed selection (MY-289) shows its published pins only, pages and articles mixed, more
 * than six, in the editor's order, with no fill for a gap and no page 2; a new publication changes
 * an automatic list and leaves the selection as it was.
 */
export async function observeOverview(
  invoker: Invoker,
  admin: Principal,
  other: Principal,
  clock: Clock
) {
  const create = async (slug: string, document: Record<string, unknown>, by = admin) =>
    (await invoker.run(useCases.createItem, by, { slug, document: document as never })).item;
  const publish = (item: { id: string; latestRevisionId: string }, locale: string, by = admin) =>
    invoker.run(useCases.publishItem, by, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale,
    });
  const buurt = await invoker.run(useCases.createSection, admin, {
    slug: 'buurt',
    title: { nl: 'Buurt' },
  });
  const inBuurt = { sectionId: buurt.id };

  clock.advance(1000);
  const oud = await create('oud', article('oud', { ...inBuurt, tags: ['Zout', 'suiker'] }));
  await publish(oud, 'nl');
  await publish(oud, 'en');
  clock.advance(1000);
  const midden = await create('midden', article('midden', { ...inBuurt, tags: ['zout'] }));
  await publish(midden, 'nl');
  clock.advance(1000);
  const nieuw = await create(
    'nieuw',
    article('nieuw', { ...inBuurt, lead: { nl: 'Kort en nieuw.', en: 'Short and new.' } })
  );
  await publish(nieuw, 'nl');
  clock.advance(1000);
  const elders = await create('elders-rubriek', article('elders-rubriek'));
  await publish(elders, 'nl');
  const pagina = await create('pagina', { ...article('pagina'), type: 'page' });
  await publish(pagina, 'nl');
  // A card from its teaser: the title and the lead, never the body behind it.
  clock.advance(1000);
  const leden = await create(
    'leden',
    article('leden', {
      ...inBuurt,
      lead: { nl: 'Voor leden.', en: 'Members.' },
      access: { level: 'members' },
      blocks: [
        { id: 'body', type: 'heading', version: 1, props: { text: { nl: 'SENTINEL-BODY' } } },
      ],
    })
  );
  await publish(leden, 'nl');
  // Never in a list: scheduled, unpublished, in the trash, another tenant, a draft.
  const gepland = await create('gepland', article('gepland', inBuurt));
  await invoker.run(useCases.scheduleItem, admin, {
    itemId: gepland.id,
    revisionId: gepland.latestRevisionId,
    locale: 'nl',
    at: new Date(clock.now().getTime() + 3_600_000).toISOString(),
  });
  const weg = await create('ingetrokken', article('ingetrokken', inBuurt));
  await publish(weg, 'nl');
  await invoker.run(useCases.unpublishItem, admin, { itemId: weg.id, locale: 'nl' });
  const prullenbak = await create('prullenbak', article('prullenbak', inBuurt));
  await publish(prullenbak, 'nl');
  await invoker.run(useCases.deleteItem, admin, { itemId: prullenbak.id });
  const vreemd = await create('vreemd', article('vreemd'), other);
  await publish(vreemd, 'nl', other);
  await create('concept', article('concept', inBuurt));
  // A later draft of `oud` changes nothing; a republish of `midden` does not move it up.
  clock.advance(1000);
  await invoker.run(useCases.updateItem, admin, {
    itemId: oud.id,
    baseRevisionId: oud.latestRevisionId,
    document: article('oud', {
      ...inBuurt,
      title: { nl: 'Concepttitel', en: 'Draft title' },
    }) as never,
  });
  const herzien = await invoker.run(useCases.updateItem, admin, {
    itemId: midden.id,
    baseRevisionId: midden.latestRevisionId,
    document: article('midden', {
      ...inBuurt,
      tags: ['zout'],
      title: { nl: 'Midden herzien' },
    }) as never,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: midden.id,
    revisionId: herzien.revision.id,
    locale: 'nl',
  });

  type Props = z.input<typeof useCases.getOverview.input>['props'];
  const get = (props: Props, locale = 'nl', page = 1, by = admin) =>
    invoker.run(useCases.getOverview, by, { props, locale, page });
  const slugs = async (props: Props, locale = 'nl', page = 1, by = admin) => {
    const { entries, older } = await get(props, locale, page, by);
    return `${entries.map((e) => `${e.slug}${e.pinned ? '*' : ''}`).join(' ')}${older ? ' +' : ''}`;
  };
  const chosen = [nieuw, pagina, weg, oud, prullenbak, gepland, midden, leden].map((i) => ({
    itemId: i.id,
  }));
  const first = (await get({ sectionId: buurt.id, limit: '2' })).entries[1];
  const members = (await get({ sectionId: buurt.id, limit: '1' })).entries[0];
  return {
    articles: await slugs({}),
    oldest: await slugs({ order: 'oldest' }),
    pages: await slugs({ source: 'page' }),
    section: await slugs({ sectionId: buurt.id }),
    // Canonical tags, and every one of them.
    oneTag: await slugs({ tags: [{ tag: ' ZOUT ' }] }),
    everyTag: await slugs({ tags: [{ tag: 'zout' }, { tag: 'suiker' }] }),
    english: await slugs({}, 'en'),
    pinsOnTop: await slugs({ limit: '3', pinned: [{ itemId: oud.id }, { itemId: pagina.id }] }),
    // `midden` is not published in English: it drops out and the list fills its place.
    pinNotInLocale: await slugs({ limit: '2', pinned: [{ itemId: midden.id }] }, 'en'),
    pinRestricted: await slugs({ limit: '2', pinned: [{ itemId: leden.id }] }),
    page1: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }),
    page2: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }, 'nl', 2),
    page3: await slugs({ limit: '2', pinned: [{ itemId: oud.id }] }, 'nl', 3),
    otherTenant: await slugs({}, 'nl', 1, other),
    // Eight chosen, three of them not published here (withdrawn, trash, scheduled): no stand-ins.
    selection: await slugs({ source: 'selection', pinned: chosen }),
    selectionEnglish: await slugs({ source: 'selection', pinned: chosen }, 'en'),
    selectionPage2: await slugs({ source: 'selection', pinned: chosen }, 'nl', 2),
    // More than six pins only in a fixed selection.
    selectionOverSix: await get({ pinned: chosen }).then(
      () => 'answered',
      (e: { code?: string; issues?: { message: string }[] }) =>
        `${e.code}:${e.issues?.[0]?.message}`
    ),
    // One new article: the newest three change, the selection does not.
    afterPublication: await (async () => {
      clock.advance(1000);
      const vers = await create('vers', article('vers', inBuurt));
      await publish(vers, 'nl');
      return {
        newest: await slugs({ limit: '3' }),
        section: await slugs({ sectionId: buurt.id, limit: '3' }),
        selection: await slugs({ source: 'selection', pinned: chosen }),
      };
    })(),
    card: first && {
      title: first.title,
      summary: first.summary,
      revisionIsPublished: first.revisionId === nieuw.latestRevisionId,
    },
    restricted: members && {
      title: members.title,
      summary: members.summary,
      restricted: members.restricted,
      body: JSON.stringify(members).includes('SENTINEL'),
    },
    // A page source carries no section or tags.
    pageWithSection: await get({ source: 'page', sectionId: buurt.id }).then(
      () => 'answered',
      (e: { code?: string }) => e.code
    ),
    // Last: the agenda advances the clock past an event's end.
    agenda: await observeAgenda(invoker, admin, clock, pagina.id),
    dossiers: await observeDossiers(invoker, admin, other, clock),
  };
}

/**
 * Dossiers (MY-260): an overview with `dossierId` lists the published members in this locale
 * (articles or pages, a restricted one as its teaser card), the source `dossier` lists the
 * published dossier pages, and `content.published.get` carries a box per dossier the item names
 * that is published in this locale, with up to three other public members, newest first. A draft
 * member, another tenant, an unpublished locale, a restricted member (in the box), a box switched
 * off and a dossier in the trash never show; an id that is no dossier page of this tenant, and
 * dossiers on a dossier page, are refused.
 */
async function observeDossiers(invoker: Invoker, admin: Principal, other: Principal, clock: Clock) {
  const create = async (slug: string, document: Record<string, unknown>, by = admin) =>
    (await invoker.run(useCases.createItem, by, { slug, document: document as never })).item;
  const publish = async (item: { id: string; latestRevisionId: string }, ...locales: string[]) => {
    for (const locale of locales)
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: item.latestRevisionId,
        locale,
      });
  };
  const dossierPage = (slug: string, over: Record<string, unknown> = {}) => ({
    ...article(slug),
    type: 'page',
    profile: 'dossier',
    ...over,
  });
  const refused = (slug: string, document: Record<string, unknown>, by = admin) =>
    create(slug, document, by).then(
      () => 'answered',
      (e: { code?: string; issues?: { message: string }[] }) =>
        `${e.code}:${e.issues?.[0]?.message}`
    );

  const wonen = await create(
    'wonen',
    dossierPage('wonen', {
      title: { nl: 'Betaalbaar wonen', en: 'Affordable housing' },
      lead: { nl: 'Alles over wonen.', en: 'All about housing.' },
    })
  );
  await publish(wonen, 'nl');
  // A draft dossier may be chosen; it shows nowhere until it is published.
  const ontwerp = await create('ontwerp-dossier', dossierPage('ontwerp-dossier'));
  const oud = await create('oud-dossier', dossierPage('oud-dossier'));
  await publish(oud, 'nl');
  const inWonen = { dossiers: [{ itemId: wonen.id }] };
  clock.advance(1000);
  const huur = await create('huur', article('huur', inWonen));
  await publish(huur, 'nl', 'en');
  clock.advance(1000);
  await publish(await create('koop', article('koop', inWonen)), 'nl');
  clock.advance(1000);
  await publish(await create('plan', { ...article('plan', inWonen), type: 'page' }), 'nl');
  clock.advance(1000);
  const leden = article('leden-wonen', {
    ...inWonen,
    lead: { nl: 'Voor leden.', en: 'Members.' },
    access: { level: 'members' },
  });
  await publish(await create('leden-wonen', leden), 'nl');
  clock.advance(1000);
  const stil = await create('stil', article('stil', { ...inWonen, showDossier: false }));
  await publish(stil, 'nl');
  clock.advance(1000);
  const twee = await create(
    'twee',
    article('twee', { dossiers: [{ itemId: ontwerp.id }, { itemId: wonen.id }] })
  );
  await publish(twee, 'nl');
  await create('concept-wonen', article('concept-wonen', inWonen));
  const inOud = await create('in-oud', article('in-oud', { dossiers: [{ itemId: oud.id }] }));
  await publish(inOud, 'nl');
  await invoker.run(useCases.deleteItem, admin, { itemId: oud.id });
  const vreemd = await create('vreemd-dossier', dossierPage('vreemd-dossier'), other);
  const gewoon = await create('gewoon', { ...article('gewoon'), type: 'page' });

  const slugs = async (props: Record<string, unknown>, locale = 'nl', by = admin) =>
    (await invoker.run(useCases.getOverview, by, { props: props as never, locale })).entries
      .map((e) => `${e.slug}${e.restricted ? '!' : ''}`)
      .join(' ');
  const boxes = async (type: 'article' | 'page', slug: string, locale = 'nl') => {
    const item = await invoker.run(useCases.getPublished, admin, { type, slug, locale });
    return (item.dossiers ?? []).map(
      (d) => `${d.slug} "${d.title}" "${d.lead}": ${d.members.map((m) => m.slug).join(' ')}`
    );
  };
  return {
    articles: await slugs({ dossierId: wonen.id }),
    pages: await slugs({ source: 'page', dossierId: wonen.id }),
    english: await slugs({ dossierId: wonen.id }, 'en'),
    otherTenant: await slugs({ dossierId: wonen.id }, 'nl', other),
    all: await slugs({ source: 'dossier' }),
    eventWithDossier: await invoker
      .run(useCases.getOverview, admin, {
        props: { source: 'event', dossierId: wonen.id },
        locale: 'nl',
      })
      .then(
        () => 'answered',
        (e: { code?: string }) => e.code
      ),
    box: await boxes('article', 'huur'),
    // The dossier is not published in English: no box there.
    boxEnglish: await boxes('article', 'huur', 'en'),
    boxOnPage: await boxes('page', 'plan'),
    switchedOff: await boxes('article', 'stil'),
    draftDossier: await boxes('article', 'twee'),
    trashedDossier: await boxes('article', 'in-oud'),
    otherTenantDossier: await refused(
      'naar-vreemd',
      article('x', { dossiers: [{ itemId: vreemd.id }] })
    ),
    notADossier: await refused('naar-gewoon', article('y', { dossiers: [{ itemId: gewoon.id }] })),
    duplicate: await refused(
      'dubbel',
      article('z', { dossiers: [{ itemId: wonen.id }, { itemId: wonen.id }] })
    ),
    onDossier: await refused('genest', dossierPage('genest', inWonen)),
  };
}

/**
 * An agenda (`source: 'event'`): pages with the event profile only, upcoming at or after the
 * site's wall clock by `endsAt ?? startsAt`, soonest first, past latest first; an event that is
 * still running is upcoming, and once the clock passes its end it is past without any save.
 */
async function observeAgenda(invoker: Invoker, admin: Principal, clock: Clock, plainId: string) {
  const zone = (await invoker.run(useCases.getSiteGeneral, admin, {})).value.timeZone;
  const at = (hours: number) =>
    wallClock(new Date(clock.now().getTime() + hours * 3_600_000), zone);
  const event = async (
    slug: string,
    startsAt: string,
    endsAt?: string,
    publish = true,
    over: Record<string, unknown> = {}
  ) => {
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'page',
        profile: 'event',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `Titel ${slug}`, en: `Title ${slug}` },
        event: { startsAt, ...(endsAt ? { endsAt } : {}), location: { nl: 'Buurthuis' } },
        blocks: [],
        ...over,
      } as never,
    });
    if (publish)
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: item.latestRevisionId,
        locale: 'nl',
      });
    return item;
  };
  // `bezig` started an hour ago and ends in half an hour; `morgen` and `ook-morgen` tie on start.
  const started = at(-1);
  await event('bezig', started, at(0.5));
  await event('morgen', at(24));
  await event('ook-morgen', at(24));
  await event('straks', at(48));
  const gisteren = await event('gisteren', at(-24), at(-22));
  await event('lang-geleden', at(-240));
  await event('concept-evenement', at(5), undefined, false);
  // An agenda sorts by when, which a members' event keeps to its members: it is left out.
  await event('ledenavond', at(6), undefined, true, {
    lead: { nl: 'Voor leden.' },
    access: { level: 'members' },
  });
  const list = async (when: 'upcoming' | 'past', extra: Record<string, unknown> = {}) => {
    const { entries, older } = await invoker.run(useCases.getOverview, admin, {
      props: { source: 'event', when, limit: '3', ...extra },
      locale: 'nl',
    });
    return `${entries.map((e) => `${e.slug}${e.pinned ? '*' : ''}`).join(' ')}${older ? ' +' : ''}`;
  };
  const before = { upcoming: await list('upcoming'), past: await list('past') };
  const card = (
    await invoker.run(useCases.getOverview, admin, {
      props: { source: 'event', limit: '1' },
      locale: 'nl',
    })
  ).entries[0]!;
  const pinned = await list('upcoming', {
    pinned: [{ itemId: gisteren.id }, { itemId: plainId }],
  });
  const second = await invoker.run(useCases.getOverview, admin, {
    props: { source: 'event', when: 'past', limit: '1', archive: true },
    locale: 'nl',
    page: 2,
  });
  // The order of an article list does not apply to an agenda.
  const ordered = await list('past', { order: 'oldest' });
  clock.advance(3_600_000);
  return {
    before,
    after: { upcoming: await list('upcoming'), past: await list('past') },
    card: {
      slug: card.slug,
      hasStart: card.event?.startsAt === started,
      location: card.event?.location,
      timeZone: card.event?.timeZone === zone,
    },
    pinned,
    page2: second.entries.map((e) => e.slug).join(' '),
    ordered,
    withSection: await invoker
      .run(useCases.getOverview, admin, {
        props: { source: 'event', sectionId: randomUUID() },
        locale: 'nl',
      })
      .then(
        () => 'answered',
        (e: { code?: string }) => e.code
      ),
  };
}

export const expectedOverview = {
  // `midden` was republished last, and stays where its first publication put it.
  articles: 'leden elders-rubriek nieuw midden oud',
  oldest: 'oud midden nieuw elders-rubriek leden',
  pages: 'pagina',
  section: 'leden nieuw midden oud',
  oneTag: 'midden oud',
  everyTag: 'oud',
  english: 'oud',
  pinsOnTop: 'oud* pagina* leden +',
  pinNotInLocale: 'oud',
  pinRestricted: 'leden* elders-rubriek +',
  page1: 'oud* leden +',
  page2: 'elders-rubriek nieuw +',
  page3: 'midden',
  otherTenant: 'vreemd',
  selection: 'nieuw* pagina* oud* midden* leden*',
  selectionEnglish: 'oud*',
  selectionPage2: '',
  selectionOverSix: 'invalid_input:content.overview.pin-limit',
  afterPublication: {
    newest: 'vers leden elders-rubriek +',
    section: 'vers leden nieuw +',
    selection: 'nieuw* pagina* oud* midden* leden*',
  },
  card: {
    title: 'Titel nieuw',
    summary: 'Kort en nieuw.',
    revisionIsPublished: true,
  },
  restricted: { title: 'Titel leden', summary: 'Voor leden.', restricted: true, body: false },
  pageWithSection: 'invalid_input',
  agenda: {
    before: { upcoming: 'bezig morgen ook-morgen +', past: 'gisteren lang-geleden' },
    after: { upcoming: 'morgen ook-morgen straks', past: 'bezig gisteren lang-geleden' },
    card: { slug: 'bezig', hasStart: true, location: 'Buurthuis', timeZone: true },
    // A pin keeps its place whatever its date; an ordinary page pinned shows too.
    pinned: 'gisteren* pagina* bezig +',
    page2: 'lang-geleden',
    ordered: 'gisteren lang-geleden',
    withSection: 'invalid_input',
  },
  dossiers: {
    articles: 'twee stil leden-wonen! koop huur',
    pages: 'plan',
    english: 'huur',
    otherTenant: '',
    all: 'wonen',
    eventWithDossier: 'invalid_input',
    box: ['wonen "Betaalbaar wonen" "Alles over wonen.": twee stil plan'],
    boxEnglish: [],
    boxOnPage: ['wonen "Betaalbaar wonen" "Alles over wonen.": twee stil koop'],
    switchedOff: [],
    draftDossier: ['wonen "Betaalbaar wonen" "Alles over wonen.": stil plan koop'],
    trashedDossier: [],
    otherTenantDossier: 'invalid_input:content.dossier.not-a-dossier',
    notADossier: 'invalid_input:content.dossier.not-a-dossier',
    duplicate: 'invalid_input:content.dossier.duplicate',
    onDossier: 'invalid_input:content.dossier.on-dossier',
  },
};
