// The `content_block_refs` backfill of migration 0017, run for real (brief #8b1 § 3). The
// migrator applies 0017 once, on whatever revisions existed then, so this suite replays the SQL
// between the `backfill:begin` and `backfill:end` markers over revisions it inserts directly
// (without refs, as before 0017), inside a transaction it rolls back. Two tenants, with form,
// item, author and section references; the rows must equal what the repository derives on save
// (`documentReferences`), so backfilled and freshly saved revisions cannot disagree.
//
// Fixture, replay and readback run under `mycel_app`, as the 0011 replay does: a non-superuser
// member that forced RLS binds, under each tenant's context. Since 0018 (TODO #20b) the owner sees no
// tenant row; the migrator ran this block as the owner while the policy was still on `public`,
// which a clean chain still does (0017 before 0018). Only the tenants are the owner's. Skips
// without DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentDocument, documentReferences } from '@mycel/core';
import { migrate, uuidv7 } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && !operatorUrl)
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL is not set');

const MIGRATION = fileURLToPath(
  new URL('../migrations/0017_content_block_refs.sql', import.meta.url)
);

describe.skipIf(!operatorUrl)('migration 0017 backfill', () => {
  const client = new pg.Client({ connectionString: operatorUrl });
  let backfill = '';
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toContain('insert into content_block_refs');
    await client.connect();
  });

  afterAll(() => client.end());

  const para = (text: string, itemId?: string) => ({
    type: 'paragraph',
    content: [
      { type: 'text', text, ...(itemId ? { marks: [{ type: 'link', attrs: { itemId } }] } : {}) },
    ],
  });
  const byRow = (x: { type: string; ref_id: string; block_id: string | null }, y: typeof x) =>
    `${x.type} ${x.ref_id} ${x.block_id}`.localeCompare(`${y.type} ${y.ref_id} ${y.block_id}`);
  const base = { defaultLocale: 'nl', locales: ['nl', 'en'], seo: { noindex: false } };

  /** Two tenants with a form, an author, a section, and items whose revisions reference them. */
  function fixture() {
    const t = (key: string) => ({
      key,
      tenant: uuidv7(),
      form: uuidv7(),
      author: uuidv7(),
      section: uuidv7(),
      target: uuidv7(),
      page: uuidv7(),
      article: uuidv7(),
    });
    const a = t('a');
    const b = t('b');
    const items = [a, b].flatMap((x) => [
      {
        tenant: x.tenant,
        id: x.target,
        type: 'page',
        document: {
          ...base,
          type: 'page',
          title: { nl: 'Doel' },
          blocks: [],
          access: { level: 'public', teaser: 'lead' },
        },
      },
      {
        tenant: x.tenant,
        id: x.page,
        type: 'page',
        document: {
          ...base,
          type: 'page',
          title: { nl: 'Pagina' },
          access: { level: 'public', teaser: 'lead' },
          blocks: [
            {
              id: 'tekst',
              type: 'rich-text',
              version: 1,
              props: {
                content: {
                  // A link in a nested list, twice to the same item, and a plain href link.
                  nl: {
                    type: 'doc',
                    content: [
                      para('zie', x.target),
                      {
                        type: 'bullet_list',
                        content: [{ type: 'list_item', content: [para('nog eens', x.target)] }],
                      },
                    ],
                  },
                  en: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [
                          {
                            type: 'text',
                            text: 'see',
                            marks: [{ type: 'link', attrs: { href: 'https://example.org/' } }],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
            { id: 'formulier', type: 'signup-form', version: 1, props: { formId: x.form } },
          ],
        },
      },
      {
        tenant: x.tenant,
        id: x.article,
        type: 'article',
        document: {
          ...base,
          type: 'article',
          title: { nl: 'Verhaal' },
          blocks: [],
          access: { level: 'public', teaser: 'lead' },
          authorIds: [x.author],
          sectionId: x.section,
          tags: [],
          corrections: [],
          delivery: { web: true },
        },
      },
    ]);
    return { tenants: [a, b], items };
  }

  async function prepare(f: ReturnType<typeof fixture>): Promise<string[]> {
    const revisions: string[] = [];
    for (const x of f.tenants)
      await client.query(
        `insert into tenants (id, slug, name, default_locale, locales) values ($1, $2, $2, 'nl', '{nl,en}')`,
        [x.tenant, `refs-${x.key}-${run}`]
      );
    // The backfill walks `tenants`, which mycel_app reads only through `tenant_directory` (0008):
    // a throwaway member of mycel_app, bound by its policies and holding its grants, gets that
    // one read on top. Rolled back with the rest.
    const role = `refs_app_${run}`;
    await client.query(`create role ${role} nologin in role mycel_app`);
    // A non-superuser with CREATEROLE administers the new role but is not yet a member (16+).
    await client.query(`grant ${role} to current_user`);
    await client.query(`grant select on tenants to ${role}`);
    await client.query(`set local role ${role}`);
    for (const x of f.tenants) {
      await client.query(`select set_config('app.tenant_id', $1, true)`, [x.tenant]);
      await client.query(`insert into forms (id, tenant_id, definition) values ($1, $2, '{}')`, [
        x.form,
        x.tenant,
      ]);
      await client.query(
        `insert into authors (id, tenant_id, slug, name, created_at, updated_at) values ($1, $2, 'ann', 'Ann', now(), now())`,
        [x.author, x.tenant]
      );
      await client.query(
        `insert into sections (id, tenant_id, slug, title, created_at, updated_at) values ($1, $2, 'bin', '{"nl":"Bin"}', now(), now())`,
        [x.section, x.tenant]
      );
    }
    for (const item of f.items) {
      ContentDocument.parse(item.document);
      const rev = uuidv7();
      revisions.push(rev);
      await client.query(`select set_config('app.tenant_id', $1, true)`, [item.tenant]);
      await client.query(
        `insert into content_items (id, tenant_id, type, slug, title, default_locale, locales, latest_revision_id, created_at, updated_at)
         values ($1, $2, $3, $4, '{"nl":"x"}', 'nl', '{nl,en}', $5, now(), now())`,
        [item.id, item.tenant, item.type, `s-${item.id.slice(-12)}`, rev]
      );
      await client.query(
        `insert into content_revisions (id, tenant_id, item_id, document, actor, created_at)
         values ($1, $2, $3, $4, '{"kind":"system","job":"test"}', now())`,
        [rev, item.tenant, item.id, JSON.stringify(item.document)]
      );
    }
    await client.query(`select set_config('app.tenant_id', '', true)`);
    return revisions;
  }

  it('derives the rows the repository would, for two tenants, under mycel_app', async () => {
    const f = fixture();
    await client.query('begin');
    try {
      const revisions = await prepare(f);
      const { rows: who } = await client.query<{ s: boolean; app: boolean }>(
        `select rolsuper as s, pg_has_role(current_user, 'mycel_app', 'usage') as app
         from pg_roles where rolname = current_user`
      );
      expect(who[0]).toEqual({ s: false, app: true });
      await client.query(backfill);

      for (const [i, item] of f.items.entries()) {
        await client.query(`select set_config('app.tenant_id', $1, true)`, [item.tenant]);
        const { rows } = await client.query<{
          tenant_id: string;
          block_id: string | null;
          type: string;
          ref_id: string;
        }>(
          `select tenant_id, block_id, type, ref_id from content_block_refs
             where revision_id = $1`,
          [revisions[i]]
        );
        const want = documentReferences(ContentDocument.parse(item.document)).map((r) => ({
          tenant_id: item.tenant,
          block_id: r.blockId,
          type: r.type,
          ref_id: r.refId,
        }));
        expect(rows.sort(byRow), `item ${i}`).toEqual(want.sort(byRow));
      }
      // Every kind is covered: per tenant one form, one item (deduplicated), one author, one section.
      await client.query(`select set_config('app.tenant_id', $1, true)`, [f.tenants[0]!.tenant]);
      const { rows: kinds } = await client.query<{ type: string; n: string }>(
        `select type, count(*) as n from content_block_refs
           where revision_id = any($1::uuid[]) and tenant_id = $2
           group by type order by type`,
        [revisions, f.tenants[0]!.tenant]
      );
      expect(kinds.map((k) => [k.type, Number(k.n)])).toEqual([
        ['author', 1],
        ['form', 1],
        ['item', 1],
        ['section', 1],
      ]);
    } finally {
      await client.query('rollback');
    }
  });
});
