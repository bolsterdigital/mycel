// A real synthetic team member makes the demo grid useful. Existing demo pages remain intact;
// rejected: inserting a new block into a page an editor may already have changed.
import type { Invoker } from '../../invoke.js';
import type { Principal } from '../../principal.js';
import { useCases } from '../../use-cases.js';
import type { BlockInput } from '../../content/blocks.js';

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
