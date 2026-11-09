// A group and its membership list are one aggregate. Compare-and-set the parent before replacing
// members in the same tenant transaction; rejected: unguarded delete/insert membership writes.
import { type Kysely, type Selectable } from 'kysely';
import { PersonGroup, type PersonGroupRepository } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { toIso } from '../infra/dates.js';

export function personGroupRepository(
  trx: Kysely<Database>,
  tenantId: string
): PersonGroupRepository {
  async function read(row: Selectable<Database['person_groups']>): Promise<PersonGroup> {
    const members = await trx
      .selectFrom('person_group_members')
      .select('person_id')
      .where('group_id', '=', row.id)
      .orderBy('sort_order')
      .execute();
    return PersonGroup.parse({
      id: row.id,
      name: row.name,
      order: row.sort_order,
      personIds: members.map((m) => m.person_id),
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
      const row = await trx
        .selectFrom('person_groups')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? read(row) : null;
    },
    async list(offset, limit) {
      const rows = await trx
        .selectFrom('person_groups')
        .selectAll()
        .orderBy('sort_order')
        .orderBy('id')
        .offset(offset)
        .limit(limit)
        .execute();
      return Promise.all(rows.map(read));
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
