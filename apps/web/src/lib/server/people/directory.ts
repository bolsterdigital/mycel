// Editorial directory reads go through the registry. Walk every page so search and group choices
// never silently omit older people. Rejected: filtering only the first API page.
import {
  useCases,
  personPageStatus,
  UseCaseError,
  type Person,
  type PersonGroup,
  type Principal,
  type Invoker,
} from '@mycel/core';
import { personPath } from '../../public/person-path.js';
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

/**
 * The site path of a person's public page in `locale`, or null when the site would not serve one
 * (an organisation, a policy of never, site-wide off, or no published article yet), for "view on
 * the site" in the admin (MY-265). It asks the same use case the public route asks, for one person,
 * so the link exists exactly when the page does. Rejected: `pageStatuses`, which walks every
 * article of the site for a list and is too costly for one edit screen.
 */
export async function personSitePath(
  principal: Principal,
  person: Pick<Person, 'slug' | 'kind'>,
  locale: string,
  defaultLocale: string,
  invoker: Invoker = runtime().invoker
): Promise<string | null> {
  if (person.kind === 'organisation') return null;
  try {
    await invoker.run(useCases.getPublicPerson, principal, { slug: person.slug, locale, limit: 1 });
  } catch (error) {
    if (error instanceof UseCaseError && error.code === 'not_found') return null;
    throw error;
  }
  return personPath(person.slug, locale, defaultLocale);
}
