// Seed a published event page (#248, migration 0060), so the export conformance carries a
// `content_items.profile` that is not null and a revision with an `event` object through export
// and import. Rejected: making the navigation fixture's target an event, which would mix two
// fixtures' reasons into one row.
import { useCases, type Invoker, type Principal } from '@mycel/core';

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
}
