// Picker choices retain assigned records outside the first page; rejected: dropping unseen authors on save.
import {
  useCases,
  MAX_PAGE_SIZE,
  isUuid,
  pickAny,
  type Principal,
  type Section,
} from '@mycel/core';
import { runtime } from '../runtime.js';
import { orNull } from '../admin/admin-actions.js';
import { withAssigned } from '../content/content-admin.js';
/** Resolve picker choices under the operator's tenant, including a failed post's selections. */
export async function relationshipChoices(
  principal: Principal,
  defaultLocale: string,
  article: boolean,
  authorIds: string[],
  sectionId: string
) {
  const { invoker } = runtime();
  const author = (a: { id: string; name: string }) => ({ id: a.id, name: a.name });
  const section = (s: Section) => ({
    id: s.id,
    title: pickAny(s.title, defaultLocale) ?? s.slug,
  });
  const [authors, sections] = article
    ? await Promise.all([
        invoker.run(useCases.listPeople, principal, { limit: MAX_PAGE_SIZE }).then(({ people }) =>
          withAssigned(
            authorIds,
            people.map(author),
            async (authorId) => {
              const a = isUuid(authorId)
                ? await orNull(invoker.run(useCases.getPerson, principal, { personId: authorId }))
                : null;
              return a && author(a);
            },
            (id) => ({ id, name: id })
          )
        ),
        invoker
          .run(useCases.listSections, principal, { limit: MAX_PAGE_SIZE })
          .then(({ sections }) =>
            withAssigned(
              sectionId ? [sectionId] : [],
              sections.map(section),
              async (sectionId) => {
                const s = isUuid(sectionId)
                  ? await orNull(invoker.run(useCases.getSection, principal, { sectionId }))
                  : null;
                return s && section(s);
              },
              (id) => ({ id, title: id })
            )
          ),
      ])
    : [[], []];
  return { authors, sections };
}
