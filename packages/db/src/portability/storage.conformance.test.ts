// The storage catalog against the live schema: every relation has an entry, every field it names
// is a column, and a column shaped like a person (an address, a phone, an actor, a supporter,
// person or operator id, a keyed digest of an address) is a listed copy or is reviewed below. A
// migration that adds such a column fails here until someone has decided whose copy it is and what
// ends it. The import's list of stored actors (`ACTOR_FIELDS`, ADR 035 rule 5) is held to the
// same catalog, so an exported table that gains an actor column cannot be imported unnormalised.
// storage.test.ts holds the rest of the catalog without a database.
// Rejected: a check in export.conformance.test.ts, which would push that suite past its size.
//
// Skips without DATABASE_URL; in CI that is a failure.

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../index.js';
import { requireDatabase } from '../testing.js';
import { TABLES } from './export.js';
import { ACTOR_FIELDS } from './import.js';
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
      ['site_settings.analytics', 'a validated Plausible site name, no person'],
      [
        'site_settings.integrations',
        'switched-on catalogue entries and a tag container id, no person',
      ],
      ['media.focal', 'a point in the image, no person'],
      ['media.variants', 'derivative names, formats and sizes, no person'],
      ['connections.consent_scopes', 'scope names of a connection, no person'],
      ['form_feed_settings.value', 'feed configuration: ids, scopes and field mappings'],
      ['campaigns.goal', 'a number to reach, no person (ADR 033)'],
      ['access_tiers.prices', 'an amount per interval, no person (MY-254 PR 4)'],
      ['media.licence', 'a licence code and, for another licence, its name; no person'],
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

  it('normalises on import every stored actor an exported table carries', async () => {
    // An operator copy in a JSON column of an exported table is a stored actor, unless reviewed.
    const reviewed = new Map([
      ['content_revisions.provenance', 'plan, suggestion and revision ids, no actor object'],
    ]);
    const { rows } = await sql<{ rel: string; col: string }>`
      select c.relname as rel, a.attname as col from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and format_type(a.atttypid, a.atttypmod) in ('json', 'jsonb')`.execute(operatorDb);
    const json = new Set(rows.map((r) => `${r.rel}.${r.col}`));
    const exported = (rel: string) => TABLES[rel as keyof typeof TABLES] === 'export';
    const actors = Object.entries(STORAGE)
      .filter(([rel]) => exported(rel))
      .flatMap(([rel, e]) =>
        e.copies
          .filter((c) => c.subject === 'operator' && json.has(`${rel}.${c.field.split('.')[0]}`))
          .map((c) => `${rel}.${c.field}`)
      )
      .filter((f) => !reviewed.has(f));
    const normalised = Object.entries(ACTOR_FIELDS).flatMap(([rel, paths]) =>
      paths.map((path) => `${rel}.${path.join('.')}`)
    );
    expect(normalised.sort()).toEqual([...new Set(actors)].sort());
    expect(
      [...reviewed.keys()].filter((f) => !json.has(f)),
      'reviewed fields that are no JSON column'
    ).toEqual([]);
  });
});
