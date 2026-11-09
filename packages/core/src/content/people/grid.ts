// The authored grid exposes only public profile fields, including for a person without a
// profile page. It resolves an already-authorised document, never an anonymous arbitrary-id
// directory query. Rejected: opening an endpoint that lets visitors choose their own person ids.
import type { TransactionContext } from '../../ports.js';
import type { BlockProps } from '../blocks.js';
import { type PublicPerson, projectPerson, personPageEnabled } from './public.js';

export type PublicPersonCard = PublicPerson & { pageEnabled: boolean };

/** Internal reference resolution after publication/access checks (or an authorised preview). */
export async function resolvePeopleGrid(
  ctx: TransactionContext,
  props: BlockProps<'people-grid'>,
  locale: string
): Promise<PublicPersonCard[]> {
  const ids =
    props.source === 'group'
      ? ((await ctx.personGroups.get(props.groupId!))?.personIds ?? [])
      : props.people.map((p) => p.personId);
  const site = (await ctx.siteSettings.general()).value;
  const people: PublicPersonCard[] = [];
  for (const id of ids) {
    const person = await ctx.authors.get(id);
    if (person)
      people.push({
        ...projectPerson(person, locale),
        pageEnabled: await personPageEnabled(ctx, person, site),
      });
  }
  return people;
}
