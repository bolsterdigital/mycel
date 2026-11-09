// Groups are ordered selections of existing people, updated on a base just like a person.
// Rejected: separate membership writes, which could leave half a reordered group on failure.
import { z } from 'zod';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { notFound, UseCaseError } from '../../errors.js';
import { defineUseCase } from '../../registry.js';
import type { TransactionContext } from '../../ports.js';
import { exampleId } from '../../util/ids.js';
import { PersonGroup, PersonGroupInput } from './model.js';
import '../ports.js';

async function checkMembers(ctx: TransactionContext, ids: string[]) {
  for (const id of ids) if (!(await ctx.authors.get(id))) throw notFound('person');
}
export const createPersonGroup = defineUseCase({
  name: 'content.person_group.create',
  kind: 'command',
  requires: 'content:write',
  consumes: null,
  description: 'Create an ordered group of people on this site.',
  input: PersonGroupInput,
  output: PersonGroup,
  examples: [{ input: { name: { en: 'Team' } } }],
  async handler(ctx, fields) {
    await checkMembers(ctx, fields.personIds);
    const now = ctx.clock.now().toISOString();
    const group = { ...fields, id: ctx.ids.next(), createdAt: now, updatedAt: now };
    await ctx.personGroups.insert(group);
    return group;
  },
});
export const updatePersonGroup = defineUseCase({
  name: 'content.person_group.update',
  kind: 'command',
  requires: 'content:write',
  description: 'Replace a group and its ordered members on the timestamp read by the caller.',
  input: PersonGroupInput.extend({
    groupId: z.string().guid(),
    baseUpdatedAt: z.string().datetime({ offset: true }),
  }),
  output: PersonGroup,
  examples: [
    {
      input: {
        groupId: exampleId(1),
        baseUpdatedAt: '2026-11-01T09:00:00.000Z',
        name: { en: 'Team' },
      },
    },
  ],
  async handler(ctx, { groupId, baseUpdatedAt, ...fields }) {
    const current = await ctx.personGroups.get(groupId);
    if (!current) throw notFound('person group');
    const conflict = () =>
      new UseCaseError('conflict', 'the group changed since baseUpdatedAt', [
        { path: 'baseUpdatedAt', message: 'content.entity.conflict' },
      ]);
    if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt)) throw conflict();
    await checkMembers(ctx, fields.personIds);
    const updatedAt = new Date(
      Math.max(ctx.clock.now().getTime(), Date.parse(baseUpdatedAt) + 1)
    ).toISOString();
    const next = { ...current, ...fields, updatedAt };
    if (!(await ctx.personGroups.update(next, baseUpdatedAt))) throw conflict();
    return next;
  },
});
export const getPersonGroup = defineUseCase({
  name: 'content.person_group.get',
  kind: 'query',
  requires: 'content:read',
  description: 'Read a group and its ordered person ids.',
  input: z.object({ groupId: z.string().guid() }),
  output: PersonGroup,
  examples: [{ input: { groupId: exampleId(1) } }],
  async handler(ctx, { groupId }) {
    const group = await ctx.personGroups.get(groupId);
    if (!group) throw notFound('person group');
    return group;
  },
});
export const listPersonGroups = defineUseCase({
  name: 'content.person_group.list',
  kind: 'query',
  requires: 'content:read',
  description: 'List the groups of this site in display order.',
  input: z.object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  }),
  output: z.object({ groups: z.array(PersonGroup), nextOffset: z.number().int().nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { offset, limit }) {
    const groups = await ctx.personGroups.list(offset, limit + 1);
    return {
      groups: groups.slice(0, limit),
      nextOffset: groups.length > limit ? offset + limit : null,
    };
  },
});
