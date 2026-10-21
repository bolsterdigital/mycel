// Kysely implementations of the core's repository ports. Each takes the transaction handle that
// `withTenant` opened, so every query runs under the tenant's RLS context. Rows carry tenant_id
// explicitly on insert; the policy's WITH CHECK rejects any mismatch.

import { sql, type Kysely } from 'kysely';
import {
  FormDefinition,
  Page,
  SupporterEvent,
  type Clock,
  type FormRepository,
  type PageRepository,
  type RateLimiter,
  type SubmissionRepository,
  type SupporterRepository,
} from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

export function pageRepository(trx: Trx, tenantId: string): PageRepository {
  return {
    async findBySlug(slug) {
      const row = await trx
        .selectFrom('pages')
        .selectAll()
        .where('slug', '=', slug)
        .executeTakeFirst();
      if (!row) return null;
      return Page.parse({
        id: row.id,
        slug: row.slug,
        defaultLocale: row.default_locale,
        locales: row.locales,
        title: row.title,
        blocks: row.blocks,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    },
    async insert(page) {
      await trx
        .insertInto('pages')
        .values({
          id: page.id,
          tenant_id: tenantId,
          slug: page.slug,
          default_locale: page.defaultLocale,
          locales: page.locales,
          title: JSON.stringify(page.title),
          blocks: JSON.stringify(page.blocks),
          created_at: page.createdAt,
          updated_at: page.updatedAt,
        })
        .execute();
    },
  };
}

export function formRepository(trx: Trx, tenantId: string): FormRepository {
  return {
    async findById(id) {
      const row = await trx
        .selectFrom('forms')
        .select('definition')
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? FormDefinition.parse(row.definition) : null;
    },
    async insert(form) {
      await trx
        .insertInto('forms')
        .values({ id: form.id, tenant_id: tenantId, definition: JSON.stringify(form) })
        .execute();
    },
  };
}

export function submissionRepository(trx: Trx, tenantId: string): SubmissionRepository {
  return {
    async insert(s) {
      await trx
        .insertInto('form_submissions')
        .values({
          id: s.id,
          tenant_id: tenantId,
          form_id: s.formId,
          values: JSON.stringify(s.values),
          locale: s.locale,
          page_url: s.pageUrl,
          ip_hash: s.ipHash,
          created_at: s.createdAt,
        })
        .execute();
    },
  };
}

export function rateLimiter(trx: Trx, tenantId: string, clock: Clock): RateLimiter {
  return {
    async hit(key, { max, windowSeconds }) {
      const windowMs = windowSeconds * 1000;
      const windowStart = new Date(Math.floor(clock.now().getTime() / windowMs) * windowMs);
      const row = await trx
        .insertInto('rate_limits')
        .values({ tenant_id: tenantId, key, window_start: windowStart, hits: 1 })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'key', 'window_start'])
            .doUpdateSet({ hits: sql`rate_limits.hits + 1` })
        )
        .returning('hits')
        .executeTakeFirstOrThrow();
      return row.hits <= max;
    },
  };
}

export function supporterRepository(trx: Trx, tenantId: string): SupporterRepository {
  return {
    async appendEvent(e) {
      const inserted = await trx
        .insertInto('events')
        .values({
          tenant_id: tenantId,
          id: e.id,
          schema: e.schema,
          type: e.type,
          email: e.email,
          occurred_at: e.occurred_at,
          source: e.source,
          source_site: e.source_site,
          source_ref: e.source_ref,
          props: JSON.stringify(e.props),
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async eventsFor(email) {
      const rows = await trx
        .selectFrom('events')
        .selectAll()
        .where('email', '=', email)
        .orderBy('occurred_at')
        .orderBy('id')
        .execute();
      return rows.map((r) =>
        SupporterEvent.parse({ ...r, occurred_at: new Date(r.occurred_at).toISOString() })
      );
    },
    async getProjection(email) {
      const row = await trx
        .selectFrom('supporters')
        .selectAll()
        .where('email', '=', email)
        .executeTakeFirst();
      if (!row) return null;
      return {
        email: row.email,
        firstSeen: new Date(row.first_seen).toISOString(),
        lastActivity: new Date(row.last_activity).toISOString(),
        lists: row.lists,
      };
    },
    async saveProjection(p) {
      const values = {
        first_seen: p.firstSeen,
        last_activity: p.lastActivity,
        lists: p.lists,
        updated_at: new Date(),
      };
      await trx
        .insertInto('supporters')
        .values({ tenant_id: tenantId, email: p.email, ...values })
        .onConflict((oc) => oc.columns(['tenant_id', 'email']).doUpdateSet(values))
        .execute();
    },
  };
}
