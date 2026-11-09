// Resolve only an authored credit's person. The public result is deliberately smaller than a
// public profile; rejected: passing an editorial Person (including internal email) to templates.
import type { TransactionContext } from '../../ports.js';
import { personPageEnabled } from './public.js';

export async function resolveCreditPerson(ctx: TransactionContext, id: string) {
  const person = await ctx.authors.get(id);
  if (!person) return null;
  return {
    name: person.name,
    slug: (await personPageEnabled(ctx, person)) ? person.slug : null,
  };
}
