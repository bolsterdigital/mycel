// Seed a published navigation with one content target (ADR 036, migration 0056), so the RLS and
// export conformance suites see a row in each navigation table: head, revision, locale pointer
// and reference. Rejected: a URL-only menu, which would leave `site_navigation_refs` empty.
// The target page switches the pre-footer off, and a zone is placed, so the export carries
// both. The target is renamed after its publication, so `content_redirects` (0062) has a row: its
// old address forwards to it.
import { useCases, type Invoker, type Principal } from '@mycel/core';

export async function seedNavigation(invoker: Invoker, admin: Principal) {
  const { item, revision } = await invoker.run(useCases.createItem, admin, {
    slug: 'menu-doel',
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Menudoel' },
      blocks: [],
      prefooter: false,
    },
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: revision.id,
    locale: 'nl',
  });
  await invoker.run(useCases.updateSlug, admin, { itemId: item.id, slug: 'menu-doel-nieuw' });
  const zone = await invoker.run(useCases.createItem, admin, {
    slug: 'zone',
    document: {
      type: 'page',
      profile: 'zone',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Zone' },
      blocks: [],
    },
  });
  const saved = await invoker.run(useCases.updateNavigation, admin, {
    baseRevisionId: null,
    document: {
      menus: [
        {
          id: 'main',
          name: 'Hoofdmenu',
          nodes: [{ id: 'doel', kind: 'link', target: { kind: 'content', itemId: item.id } }],
        },
      ],
      placements: {
        main: { menuId: 'main', bar: ['doel'] },
        actions: null,
        footer: [],
        legal: null,
        prefooter: { itemId: zone.item.id },
      },
    },
  });
  await invoker.run(useCases.publishNavigation, admin, {
    revisionId: saved.revisionId!,
    locale: 'nl',
  });
}
