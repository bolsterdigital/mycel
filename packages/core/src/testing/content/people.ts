// A real synthetic team member makes the demo grid useful. Existing demo pages remain intact;
// rejected: inserting a new block into a page an editor may already have changed.
import type { Invoker } from '../../invoke.js';
import type { Principal } from '../../principal.js';
import { useCases } from '../../use-cases.js';
import type { BlockInput } from '../../content/blocks.js';
import { BLOCK_DEFINITIONS } from '../../content/block-types.js';

export async function demoPerson(invoker: Invoker, principal: Principal): Promise<string> {
  let after: string | undefined;
  do {
    const page = await invoker.run(useCases.listPeople, principal, { after, limit: 100 });
    const found = page.people.find((p) => p.slug === 'demo-noor');
    if (found) return found.id;
    after = page.next ?? undefined;
  } while (after);
  return (
    await invoker.run(useCases.createPerson, principal, {
      slug: 'demo-noor',
      name: 'Noor Bakker',
      role: { nl: 'Coördinator vrijwilligers', en: 'Volunteer coordinator' },
      bio: {
        nl: 'Noor brengt ouders en bakkers samen om het zout in pepernoten te meten.',
        en: 'Noor brings parents and bakers together to measure the salt in pepernoten.',
      },
    })
  ).id;
}

export function peopleBlock(personId?: string): BlockInput {
  return {
    type: 'people-grid',
    version: 1,
    props: {
      source: 'selection',
      groupId: null,
      people: personId ? [{ personId }] : [],
      columns: '2',
      showBio: true,
      showRole: true,
      showContact: false,
    },
  };
}

// The demo page's team and its latest articles: the grid, a sentence, an overview of the newest
// articles, as one run so the overview has text before it and the page's next sentence
// after it. Here and not in demo-content.ts, which stands at its size ceiling.
const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
});

export function teamAndNews(personId: string | undefined): BlockInput[] {
  return [
    peopleBlock(personId),
    {
      type: 'rich-text',
      version: BLOCK_DEFINITIONS['rich-text'].version,
      props: {
        content: {
          nl: paragraph('Wat we meten en wie we spreken, staat in onze nieuwste berichten.'),
          en: paragraph('What we measure and whom we talk to is in our latest posts.'),
        },
      },
    },
    {
      type: 'overview',
      version: BLOCK_DEFINITIONS.overview.version,
      props: {
        source: 'article',
        sectionId: null,
        dossierId: null,
        tags: [],
        when: 'upcoming',
        order: 'newest',
        limit: '3',
        pinned: [],
        layout: 'cards',
        archive: false,
        width: 'wide',
      },
    },
  ];
}
