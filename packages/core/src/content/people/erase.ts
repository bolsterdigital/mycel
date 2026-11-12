// The person erasure request of ADR 034. `content.person.erase` names explicit person ids of this
// tenant's people register, appends them to the person register and plans the background apply
// in the same transaction, like `supporter.erase` (ADR 032): the front registers, the worker
// applies (`ctx.erasures.apply()`, which removes the person and scrubs the names beside their
// credits). It never derives a person from a supporter, an address, a name or a credit text.
//
// The result is the state of the request, not a claim that the human is gone from the site:
// `applied` says the person row is removed, and `notErased` always names what a person id cannot
// find (names typed in text, the pixels of an image; ADR 034 rules 3 and 6).
//
// Rejected: a capability of its own (one irreversible effect, one capability; ADR 034 rule 1), a
// partial registration when one id is unknown (the register would then depend on which ids the
// caller got right; the request is refused whole) and deleting the person row here (the worker
// owns the eraser role, ADR 011).

import { z } from 'zod';
import { notFound } from '../../errors.js';
import { jobKey } from '../../jobs/types.js';
import '../../jobs/ports.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import '../ports.js';

/** What an erasure by person id does not reach; always reported (ADR 034 rule 6). */
export const PERSON_NOT_ERASED = ['text-mentions', 'image-pixels'] as const;

export const PersonErasureView = z.object({
  personId: z.string().guid(),
  registeredAt: z.string().datetime(),
  /** The worker has applied the register: the person row is gone, credit names are scrubbed. */
  applied: z.boolean(),
});
export type PersonErasureView = z.infer<typeof PersonErasureView>;

const PersonIds = z
  .array(z.string().guid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'content.authors.duplicate');

async function view(ctx: TransactionContext, personId: string): Promise<PersonErasureView | null> {
  const registration = await ctx.personErasures.get(personId);
  if (!registration) return null;
  return {
    personId,
    registeredAt: registration.registeredAt.toISOString(),
    applied: !(await ctx.authors.get(personId)),
  };
}

export const erasePeople = defineUseCase({
  name: 'content.person.erase',
  kind: 'command',
  description:
    'Erase people of the people register on request, by explicit person id: registers each id permanently and plans the background removal of the person (profile, contact data, group memberships) and of the name stored beside their image credits in every revision, pattern, plan and media item. Their ids stay in documents as references to nobody. Names typed in text and the pixels of images are not found from a person id and are not erased; the result says so. Refused whole when an id is not a person of this site. Works while the site is suspended.',
  requires: 'supporters:erase',
  effect: 'erase',
  input: z.object({ personIds: PersonIds }).strict(),
  output: z.object({
    people: z.array(PersonErasureView),
    /** The ids this request registered; the rest were registered before. */
    created: z.array(z.string().guid()),
    notErased: z.array(z.enum(PERSON_NOT_ERASED)),
  }),
  examples: [{ input: { personIds: [exampleId(1)] } }],
  async handler(ctx, { personIds }) {
    const before = await ctx.personErasures.registered(personIds);
    const unknown: string[] = [];
    for (const id of personIds)
      if (!before.has(id) && !(await ctx.authors.get(id))) unknown.push(id);
    if (unknown.length) throw notFound('person', `id ${unknown.join(', ')}`);
    const created = await ctx.personErasures.register(personIds);
    const people = (await Promise.all(personIds.map((id) => view(ctx, id)))).map((v) => v!);
    const open = people.filter((p) => !p.applied).map((p) => p.personId);
    if (open.length)
      await ctx.jobs.enqueue({
        type: 'person.erase',
        // One key per request: a registration is permanent, so its smallest open id is unique
        // to the requests that still have work, and a retry of the same request finds its job.
        key: jobKey('person.erase', [...open].sort()[0]!),
        runAt: ctx.clock.now(),
        payload: { personIds: open },
      });
    return { people, created, notErased: [...PERSON_NOT_ERASED] };
  },
});
