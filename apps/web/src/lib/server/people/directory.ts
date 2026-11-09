// Editorial directory reads go through the registry. Walk every page so search and group choices
// never silently omit older people. Rejected: filtering only the first API page.
import {
  useCases,
  personPageStatus,
  type Person,
  type PersonGroup,
  type Principal,
  type Invoker,
} from '@mycel/core';
import { runtime } from '../runtime.js';

export async function peopleDirectory(
  principal: Principal,
  invoker: Invoker = runtime().invoker
): Promise<Person[]> {
  const people: Person[] = [];
  let after: string | undefined;
  do {
    const page = await invoker.run(useCases.listPeople, principal, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    people.push(...page.people);
    after = page.next ?? undefined;
  } while (after);
  return people;
}
export async function groupDirectory(
  principal: Principal,
  invoker: Invoker = runtime().invoker
): Promise<PersonGroup[]> {
  const groups: PersonGroup[] = [];
  let offset: number | null = 0;
  do {
    const page: { groups: PersonGroup[]; nextOffset: number | null } = await invoker.run(
      useCases.listPersonGroups,
      principal,
      {
        limit: 100,
        offset,
      }
    );
    groups.push(...page.groups);
    offset = page.nextOffset;
  } while (offset !== null);
  return groups;
}

// A published byline belongs to the pinned revision, not the latest draft. Read each distinct
// publication once, including other locales, and only count whether a person has any article.
export async function pageStatuses(
  principal: Principal,
  people: Person[],
  invoker: Invoker = runtime().invoker
) {
  const site = await invoker.run(useCases.getSiteGeneral, principal, {});
  const authors = new Set<string>();
  if (site.value.personPages !== 'off' && people.some((p) => p.pagePolicy === 'auto')) {
    let after: string | undefined;
    do {
      const page = await invoker.run(useCases.listItems, principal, {
        type: 'article',
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const item of page.items) {
        const revisions = new Set(
          item.publication.flatMap((p) => (p.publishedRevisionId ? [p.publishedRevisionId] : []))
        );
        for (const revisionId of revisions) {
          const { revision } = await invoker.run(useCases.getItem, principal, {
            itemId: item.id,
            revisionId,
          });
          if (revision.document.type === 'article')
            for (const id of revision.document.authorIds) authors.add(id);
        }
      }
      after = page.next ?? undefined;
    } while (after);
  }
  return Object.fromEntries(
    people.map((p) => [p.id, personPageStatus(site.value, p, authors.has(p.id) ? 1 : 0)])
  );
}
