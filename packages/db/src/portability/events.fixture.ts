// Seed a published event page (migration 0060), so the export conformance carries a
// `content_items.profile` that is not null and a revision with an `event` object through export
// and import. Rejected: making the navigation fixture's target an event, which would mix two
// fixtures' reasons into one row. `checkProfilesCarried` reads back what this fixture and the
// navigation fixture's zone put in: the profiles on the items, the event's details and
// `prefooter: false` in the revisions, and the placement in the navigation revision. A dossier
// (MY-260) and an article that names it travel the same way: the profile on the item, the
// membership in the article's revision.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { useCases, type Invoker, type Principal } from '@mycel/core';

export async function checkProfilesCarried(tables: string) {
  const read = (table: string) => readFile(join(tables, `${table}.ndjson`), 'utf8');
  const items = await read('content_items');
  for (const profile of ['event', 'zone', 'dossier'])
    expect(items).toContain(`"profile": "${profile}"`);
  const revisions = await read('content_revisions');
  expect(revisions).toContain('"startsAt": "2026-12-05T20:00"');
  expect(revisions).toContain('"prefooter": false');
  expect(revisions).toContain('"dossiers": [');
  expect(revisions).toContain('"showDossier": false');
  expect(await read('site_navigation_revisions')).toContain('"prefooter": {');
}

export async function seedEvent(invoker: Invoker, admin: Principal) {
  const { item, revision } = await invoker.run(useCases.createItem, admin, {
    slug: 'buurtavond',
    document: {
      type: 'page',
      profile: 'event',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Buurtavond' },
      blocks: [],
      event: {
        startsAt: '2026-12-05T20:00',
        endsAt: '2026-12-05T22:00',
        location: { nl: 'Buurthuis, Kerkstraat 1' },
        onlineUrl: 'https://example.org/live',
      },
    },
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: revision.id,
    locale: 'nl',
  });
  await seedDossier(invoker, admin);
}

async function seedDossier(invoker: Invoker, admin: Principal) {
  const page = { defaultLocale: 'nl', locales: ['nl'], blocks: [] };
  const { item: dossier } = await invoker.run(useCases.createItem, admin, {
    slug: 'wonen',
    document: { ...page, type: 'page', profile: 'dossier', title: { nl: 'Betaalbaar wonen' } },
  });
  await invoker.run(useCases.createItem, admin, {
    slug: 'huur',
    document: {
      ...page,
      type: 'article',
      title: { nl: 'Huur' },
      dossiers: [{ itemId: dossier.id }],
      showDossier: false,
    },
  });
}
