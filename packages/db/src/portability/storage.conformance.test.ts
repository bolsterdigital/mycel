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
      ['tenants.name', 'the name of the organisation that runs the site, no person'],
      ['tenant_directory.name', 'the same organisation name, through the view'],
      ['tenants.entitlements', 'features and limits, no person'],
      ['site_settings.theme', 'validated theme values, no free text'],
      ['site_settings.images', 'media ids of the default images, no person'],
      ['site_settings.retention', 'a number of months, no person'],
      ['media.focal', 'a point in the image, no person'],
      ['media.variants', 'derivative names, formats and sizes, no person'],
      ['connections.consent_scopes', 'scope names of a connection, no person'],
      ['form_feed_settings.value', 'feed configuration: ids, scopes and field mappings'],
      ['campaigns.goal', 'a number to reach, no person (ADR 033)'],
    ]);
    const { rows } = await sql<{ rel: string; col: string; json: boolean }>`
      select c.relname as rel, a.attname as col,
             format_type(a.atttypid, a.atttypmod) in ('json', 'jsonb') as json from pg_class c
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
    // A name, title or other typed text, and any JSON, may name someone (R2 of the D review).
    const personShaped =
      /(email|phone|subscriber|^actor|_by$|ip_hash|member_hash|supporter_id|person_id|operator_id|(^|_)name$|title|caption|description|note)/;
    const json = new Set(rows.filter((r) => r.json).map((r) => `${r.rel}.${r.col}`));
    const unlisted = [...columns]
      .filter((f) => personShaped.test(f.split('.')[1]!) || json.has(f))
      .filter((f) => !listed.has(f) && !reviewed.has(f));
    expect(unlisted, 'person-shaped columns outside the storage catalog').toEqual([]);
  });
});
