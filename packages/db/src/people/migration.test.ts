// Replay the actual forward SQL against legacy authors in an isolated schema. A pristine
// migration alone cannot prove preservation of existing names, ids and internal addresses.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, it, expect } from 'vitest';
import { requireDatabase } from '../testing.js';
const { skip, operator } = requireDatabase();

describe.skipIf(skip)('people migration', () => {
  it('renames existing authors without copying internal email to public contact', async () => {
    const client = new pg.Client({ connectionString: operator });
    await client.connect();
    try {
      await client.query('begin');
      await client.query('create schema people_migration_test');
      await client.query('set local search_path = people_migration_test, public');
      await client.query('create table tenants (id uuid primary key)');
      const old = await readFile(
        new URL('../../migrations/0011_content_items_and_revisions.sql', import.meta.url),
        'utf8'
      );
      await client.query(
        old.slice(old.indexOf('create table authors ('), old.indexOf('create table sections ('))
      );
      await client.query("insert into tenants values ('01900000-0000-7000-8000-000000000001')");
      await client.query(`insert into authors (id, tenant_id, slug, name, email, created_at, updated_at)
        values ('01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000000001', 'sam', 'Sam', 'private@example.org', now(), now())`);
      const before = (await client.query('select * from authors')).rows[0];
      const migration = await readFile(
        new URL('../../migrations/0041_people.sql', import.meta.url),
        'utf8'
      );
      await client.query(migration);
      const after = (await client.query('select * from people')).rows[0];
      expect(after).toMatchObject(before);
      expect(after.public_email).toBeNull();
      expect(after.page_policy).toBe('auto');
      expect(
        (await client.query("select to_regclass('people_migration_test.authors') as name")).rows[0]
          .name
      ).toBeNull();
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
