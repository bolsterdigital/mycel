// A group and its membership list are one aggregate. Compare-and-set the parent before replacing
// members in the same tenant transaction; rejected: unguarded delete/insert membership writes.
import { type Kysely, type Selectable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { PersonGroup, type PersonGroupRepository } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { toIso } from '../infra/dates.js';

export function personGroupRepository(
  trx: Kysely<Database>,
  tenantId: string
): PersonGroupRepository {
  // One statement reads the stamp and members from the same MVCC snapshot. Two queries could
  // return an old stamp with a newly committed membership list.
  const rows = () =>
    trx
      .selectFrom('person_groups')
      .selectAll('person_groups')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('person_group_members')
            .select('person_id')
            .whereRef('group_id', '=', 'person_groups.id')
            .orderBy('sort_order')
        ).as('members')
      );
  function read(
    row: Selectable<Database['person_groups']> & { members: { person_id: string }[] }
  ): PersonGroup {
    return PersonGroup.parse({
      id: row.id,
      name: row.name,
      order: row.sort_order,
      personIds: row.members.map((m) => m.person_id),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    });
  }
  async function members(group: PersonGroup) {
    await trx.deleteFrom('person_group_members').where('group_id', '=', group.id).execute();
    if (group.personIds.length)
      await trx
        .insertInto('person_group_members')
        .values(
          group.personIds.map((personId, order) => ({
            tenant_id: tenantId,
            group_id: group.id,
            person_id: personId,
            sort_order: order,
          }))
        )
        .execute();
  }
  const fields = (g: PersonGroup) => ({
    name: JSON.stringify(g.name),
    sort_order: g.order,
    updated_at: g.updatedAt,
  });
  return {
    async get(id) {
      const row = await rows().where('id', '=', id).executeTakeFirst();
      return row ? read(row) : null;
    },
    async list(offset, limit) {
      const found = await rows()
        .orderBy('sort_order')
        .orderBy('id')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(read);
    },
    async insert(group) {
      await trx
        .insertInto('person_groups')
        .values({
          id: group.id,
          tenant_id: tenantId,
          created_at: group.createdAt,
          ...fields(group),
        })
        .execute();
      await members(group);
    },
    async update(group, base) {
      const result = await trx
        .updateTable('person_groups')
        .set(fields(group))
        .where('id', '=', group.id)
        .where('updated_at', '=', new Date(base))
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return false;
      await members(group);
      return true;
    },
  };
}
