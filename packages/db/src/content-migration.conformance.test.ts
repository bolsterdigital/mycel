// The probe-page backfill of migration 0011, run for real (brief #8a § 5). The migrator applies
// 0011 once, on whatever `pages` held then, so this suite replays the exact SQL between the
// `backfill:begin` and `backfill:end` markers of the migration file over a recreated `pages`
// table, inside a transaction it rolls back. Two tenants, a complete bilingual page, a page with
// a missing translation and a page that is not valid: the first two convert and publish only
// their complete locales, the third stops the whole conversion with its page id.
//
// Tenant work runs under `mycel_app`, as a non-superuser member that forced RLS binds, whatever
// the operator is (CI's service container makes it a superuser, which would bypass RLS and prove
// nothing). Since 0018 (TODO #20b) every `tenant_isolation` policy is bound to mycel_app, so the
// owner sees no tenant row and could not replay this at all: the migrator ran it as the owner
// while the policies were still on `public`, which a clean chain still does (0011 before 0018).
// Only the tenants and the recreated `pages` table are the owner's. Skips without DATABASE_URL;
// with E2E_REQUIRED=1 (CI) that is a failure.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentDocument } from '@mycel/core';
import { migrate, uuidv7 } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && !operatorUrl)
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL is not set');

const MIGRATION = fileURLToPath(
  new URL('../migrations/0011_content_items_and_revisions.sql', import.meta.url)
);

/** The `pages` table and policy as 0002 created them. */
const PAGES_0002 = `
  create table pages (
    id uuid primary key, tenant_id uuid not null references tenants(id),
    slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    default_locale text not null, locales text[] not null, title jsonb not null,
    blocks jsonb not null, created_at timestamptz not null, updated_at timestamptz not null,
    unique (tenant_id, slug));
  alter table pages enable row level security;
  alter table pages force row level security;
  create policy tenant_isolation on pages
    using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());`;

/** Block ids are md5(page id ':' position) as a UUID: the same input converts to the same ids. */
const blockId = (pageId: string, position: number) => {
  const h = createHash('md5').update(`${pageId}:${position}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

describe.skipIf(!operatorUrl)('migration 0011 backfill', () => {
  const client = new pg.Client({ connectionString: operatorUrl });
  let backfill = '';
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toContain('insert into content_items');
    await client.connect();
  });

  afterAll(() => client.end());

  const tenant = { a: uuidv7(), b: uuidv7() };
  const form = { a: uuidv7(), b: uuidv7() };
  const page = { complete: uuidv7(), partial: uuidv7(), solo: uuidv7(), broken: uuidv7() };

  /** Fresh transaction: tenants, the old pages table, then under mycel_app forms and pages. */
  async function prepare(
    pages: {
      id: string;
      tenant: string;
      slug: string;
      title: object;
      blocks: object[];
      locales?: string[];
    }[]
  ) {
    await client.query('begin');
    try {
      await fill(pages);
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  }

  async function fill(pages: Parameters<typeof prepare>[0]) {
    await client.query(PAGES_0002);
    for (const [key, id] of Object.entries(tenant))
      await client.query(
        `insert into tenants (id, slug, name, default_locale, locales) values ($1, $2, $2, 'nl', '{nl,en}')`,
        [id, `mig-${key}-${run}`]
      );
    // The backfill walks `tenants`, which mycel_app reads only through `tenant_directory` (0008):
    // a throwaway member of mycel_app, bound by its policies and holding its grants, gets that
    // one read on top. Rolled back with the rest.
    const role = `mig_app_${run}`;
    await client.query(`create role ${role} nologin in role mycel_app`);
    // A non-superuser with CREATEROLE administers the new role but is not yet a member (16+).
    await client.query(`grant ${role} to current_user`);
    await client.query(`grant select on tenants to ${role}`);
    await client.query(`grant select, insert on pages to ${role}`);
    await client.query(`set local role ${role}`);
    for (const [key, id] of Object.entries(tenant)) {
      await client.query(`select set_config('app.tenant_id', $1, true)`, [id]);
      await client.query(`insert into forms (id, tenant_id, definition) values ($1, $2, '{}')`, [
        form[key as 'a' | 'b'],
        id,
      ]);
    }
    for (const p of pages) {
      await client.query(`select set_config('app.tenant_id', $1, true)`, [p.tenant]);
      await client.query(
        `insert into pages values ($1, $2, $3, 'nl', $4, $5, $6, '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z')`,
        [
          p.id,
          p.tenant,
          p.slug,
          p.locales ?? ['nl', 'en'],
          JSON.stringify(p.title),
          JSON.stringify(p.blocks),
        ]
      );
    }
    await client.query(`select set_config('app.tenant_id', '', true)`);
  }

  async function read(tenantId: string) {
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rows } = await client.query<{
      id: string;
      slug: string;
      created_at: Date;
      document: unknown;
      revision_id: string;
      actor: unknown;
      locales: { locale: string; status: string; published_revision_id: string | null }[];
    }>(
      `select i.id, i.slug, i.created_at, r.document, r.id as revision_id, r.actor,
              (select json_agg(json_build_object('locale', l.locale, 'status', l.status,
                       'published_revision_id', l.published_revision_id) order by l.locale)
               from content_item_locales l where l.item_id = i.id) as locales
       from content_items i join content_revisions r on r.id = i.latest_revision_id
       order by i.slug`
    );
    return rows;
  }

  const heading = (text: object) => ({ type: 'heading', version: 1, props: { text } });
  const signup = (formId: string) => ({ type: 'signup-form', version: 1, props: { formId } });

  it('converts two tenants under mycel_app, publishing only complete locales', async () => {
    await prepare([
      {
        id: page.complete,
        tenant: tenant.a,
        slug: 'complete',
        title: { nl: 'Doe mee', en: 'Join' },
        blocks: [heading({ nl: 'Kop', en: 'Heading' }), signup(form.a)],
      },
      {
        id: page.partial,
        tenant: tenant.a,
        slug: 'partial',
        title: { nl: 'Half', en: 'Half' },
        blocks: [heading({ nl: 'Alleen Nederlands' })],
      },
      {
        id: page.solo,
        tenant: tenant.b,
        slug: 'solo',
        title: { nl: 'Alleen nl' },
        blocks: [signup(form.b)],
      },
    ]);
    try {
      const { rows: who } = await client.query<{ s: boolean; app: boolean }>(
        `select rolsuper as s, pg_has_role(current_user, 'mycel_app', 'usage') as app
         from pg_roles where rolname = current_user`
      );
      expect(who[0]).toEqual({ s: false, app: true });
      await client.query(backfill);
      // The deferred latest-revision key is checked now instead of at a commit that never comes.
      await client.query('set constraints all immediate');

      const a = await read(tenant.a);
      expect(a.map((r) => [r.slug, r.locales.map((l) => `${l.locale}:${l.status}`)])).toEqual([
        ['complete', ['en:published', 'nl:published']],
        ['partial', ['en:draft', 'nl:published']],
      ]);
      const complete = a[0]!;
      expect(complete.id).toBe(page.complete);
      expect(complete.created_at.toISOString()).toBe('2026-10-01T10:00:00.000Z');
      expect(complete.revision_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8/);
      expect(complete.actor).toEqual({ kind: 'system', job: 'migration:0011' });
      const doc = ContentDocument.parse(complete.document);
      expect(doc.blocks.map((b) => b.id)).toEqual([
        blockId(page.complete, 1),
        blockId(page.complete, 2),
      ]);
      expect(doc.blocks[1]).toMatchObject({ type: 'signup-form', props: { formId: form.a } });
      ContentDocument.parse(a[1]!.document);

      const b = await read(tenant.b);
      expect(b.map((r) => [r.slug, r.locales.map((l) => `${l.locale}:${l.status}`)])).toEqual([
        ['solo', ['en:draft', 'nl:published']],
      ]);
      // Tenant context per tenant: A's rows are invisible under B's context.
      expect(b.some((r) => r.id === page.complete)).toBe(false);
    } finally {
      await client.query('rollback');
    }
  });

  it.each([
    [
      'an unknown block type',
      [{ type: 'carousel', version: 1, props: {} }],
      {},
      /unknown type carousel/,
    ],
    [
      'a form of another tenant',
      [{ type: 'signup-form', version: 1, props: { formId: 'B' } }],
      {},
      /references no form/,
    ],
    ['a title value outside locales', [], { de: 'Hallo' }, /title has a value outside locales/],
  ])(
    'stops on %s, naming the page, and leaves nothing behind',
    async (_label, blocks, extraTitle, reason) => {
      await prepare([
        {
          id: page.complete,
          tenant: tenant.a,
          slug: 'complete',
          title: { nl: 'Goed' },
          blocks: [],
        },
        {
          id: page.broken,
          tenant: tenant.a,
          slug: 'broken',
          title: { nl: 'Kapot', ...extraTitle },
          blocks: blocks.map((b) =>
            b.props && 'formId' in b.props ? { ...b, props: { formId: form.b } } : b
          ),
        },
      ]);
      try {
        await client.query('savepoint before_backfill');
        const error = await client.query(backfill).then(
          () => null,
          (e: Error) => e
        );
        expect(error?.message).toContain(page.broken);
        expect(error?.message).toMatch(reason);
        await client.query('rollback to savepoint before_backfill');
        expect(await read(tenant.a)).toEqual([]);
      } finally {
        await client.query('rollback');
      }
    }
  );
});
