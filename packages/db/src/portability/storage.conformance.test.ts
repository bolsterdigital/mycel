// The storage catalog against the live schema: every relation has an entry, every field it names
// is a column, and a column shaped like a person (an address, a phone, an actor, a supporter,
// person or operator id, a keyed digest of an address) is a listed copy or is reviewed below. A
// migration that adds such a column fails here until someone has decided whose copy it is and what
// ends it. storage.test.ts holds the rest of the catalog without a database.
// Rejected: a check in export.conformance.test.ts, which would push that suite past its size.
//
// Skips without DATABASE_URL; in CI that is a failure.

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../index.js';
import { requireDatabase } from '../testing.js';
import { STORAGE } from './storage.js';

const { skip, operator: operatorUrl } = requireDatabase();

describe.skipIf(skip)('storage catalog against the schema', () => {
  const operatorDb = createDb(operatorUrl);
  afterAll(() => operatorDb.destroy());

  it('classifies every relation and every person-shaped column in the storage catalog', async () => {
    const reviewed = new Map([
      ['audit_log.actor_kind', 'the kind of actor, no person'],
      ['content_presence.actor_kind', 'the kind of actor, no person'],
      ['operators.email_verified_at', 'a timestamp, no person'],
    ]);
    const { rows } = await sql<{ rel: string; col: string }>`
      select c.relname as rel, a.attname as col from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v')
        and not c.relispartition and c.relname <> 'schema_migrations'`.execute(operatorDb);
    const relations = [...new Set(rows.map((r) => r.rel))].sort();
    expect(relations, 'relations without a storage entry').toEqual(Object.keys(STORAGE).sort());
    const columns = new Set(rows.map((r) => `${r.rel}.${r.col}`));
    const listed = new Set(
      Object.entries(STORAGE).flatMap(([rel, e]) =>
        e.copies.map((c) => `${rel}.${c.field.split('.')[0]}`)
      )
    );
    expect(
      [...listed].filter((f) => !columns.has(f)),
      'catalog fields that are no column'
    ).toEqual([]);
    const personShaped =
      /(email|phone|subscriber|^actor|_by$|ip_hash|member_hash|supporter_id|person_id|operator_id)/;
    const unlisted = [...columns]
      .filter((f) => personShaped.test(f.split('.')[1]!))
      .filter((f) => !listed.has(f) && !reviewed.has(f));
    expect(unlisted, 'person-shaped columns outside the storage catalog').toEqual([]);
  });
});
