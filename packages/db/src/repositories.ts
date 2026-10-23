// Kysely implementations of the core's repository ports. Each takes the transaction handle that
// `withTenant` opened, so every query runs under the tenant's RLS context. Rows carry tenant_id
// explicitly on insert; the policy's WITH CHECK rejects any mismatch.

import { sql, type Kysely, type Selectable } from 'kysely';
import {
  FormDefinition,
  SupporterEvent,
  type Clock,
  type FormRepository,
  type Ids,
  type MailSend,
  type MailSendsRepository,
  type RateLimiter,
  type SubmissionRepository,
  type SupporterProjection,
  type SupporterRepository,
} from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

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
          confirmed_at: s.confirmedAt,
          list: s.list,
          consent_text_version: s.consentTextVersion,
        })
        .execute();
    },
    async findById(id) {
      const row = await trx
        .selectFrom('form_submissions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        formId: row.form_id,
        values: row.values,
        locale: row.locale,
        pageUrl: row.page_url,
        ipHash: row.ip_hash,
        createdAt: new Date(row.created_at),
        confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
        list: row.list,
        consentTextVersion: row.consent_text_version,
      };
    },
    async confirm(id, at) {
      // One conditional update: the first click sets it, every later click matches no row.
      const row = await trx
        .updateTable('form_submissions')
        .set({ confirmed_at: at })
        .where('id', '=', id)
        .where('confirmed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

/** Intent rows for transactional mail (ADR 019 rule 6); `sendOnce` in the core has the protocol. */
export function mailSendsRepository(trx: Trx, tenantId: string): MailSendsRepository {
  const toMailSend = (row: Selectable<Database['mail_sends']>): MailSend => ({
    key: row.key,
    subscriber: row.subscriber,
    eventId: row.event_id,
    attemptedAt: row.attempted_at ? new Date(row.attempted_at) : null,
    claimedUntil: row.claimed_until ? new Date(row.claimed_until) : null,
    attempts: row.attempts,
    sentAt: row.sent_at ? new Date(row.sent_at) : null,
    abandonedAt: row.abandoned_at ? new Date(row.abandoned_at) : null,
    providerId: row.provider_id,
    lastError: row.last_error,
    correlation: row.correlation,
  });
  return {
    async get(key) {
      const row = await trx
        .selectFrom('mail_sends')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst();
      return row ? toMailSend(row) : null;
    },
    // One statement (0013): Postgres serialises the conflict update on the primary key, so of
    // two callers that read the same `attempted_at`, exactly one gets the row back. A brand-new
    // key is the same case: the second insert waits for the first, then finds `attempted_at` set
    // where it expected null.
    async claim(intent, { at, until, expected }) {
      const { rows } = await sql<Selectable<Database['mail_sends']>>`
        insert into mail_sends
          (tenant_id, key, subscriber, event_id, attempted_at, claimed_until, attempts, correlation)
        values (${tenantId}, ${intent.key}, ${intent.subscriber}, ${intent.eventId}, ${at},
                ${until}, 1, ${intent.correlation})
        on conflict (tenant_id, key) do update set
          attempted_at = excluded.attempted_at,
          claimed_until = excluded.claimed_until,
          attempts = mail_sends.attempts + 1,
          correlation = excluded.correlation
        where mail_sends.sent_at is null
          and mail_sends.abandoned_at is null
          and (mail_sends.claimed_until is null or mail_sends.claimed_until <= excluded.attempted_at)
          and mail_sends.attempted_at is not distinct from ${expected}::timestamptz
        returning *`.execute(trx);
      return rows[0] ? toMailSend(rows[0]) : null;
    },
    async sent(key, at, providerId) {
      await trx
        .updateTable('mail_sends')
        .set({ sent_at: at, provider_id: providerId })
        .where('key', '=', key)
        .execute();
    },
    async failed(key, error, at) {
      await trx
        .updateTable('mail_sends')
        .set({ last_error: error.slice(0, 1000), claimed_until: at })
        .where('key', '=', key)
        .execute();
    },
    async abandon(key, at) {
      await trx
        .updateTable('mail_sends')
        .set({ abandoned_at: at })
        .where('key', '=', key)
        .where('sent_at', 'is', null)
        .where('abandoned_at', 'is', null)
        .execute();
    },
    async siblings(correlation, { since, until }) {
      const rows = await trx
        .selectFrom('mail_sends')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('correlation', '=', correlation)
        .where('attempted_at', '>=', since)
        .where('attempted_at', '<=', until)
        .execute();
      return rows.map(toMailSend);
    },
    async unresolved(now) {
      const rows = await trx
        .selectFrom('mail_sends')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('attempted_at', 'is not', null)
        .where('sent_at', 'is', null)
        .where((eb) => eb.or([eb('claimed_until', 'is', null), eb('claimed_until', '<=', now)]))
        .orderBy('attempted_at')
        .execute();
      return rows.map(toMailSend);
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
    async cooldown(key, seconds) {
      // The hourly sweep keeps a day of windows (janitor.ts); a longer wait would be forgotten.
      if (!(seconds > 0 && seconds <= 24 * 60 * 60))
        throw new Error(`cooldown: ${seconds}s is outside (0, one day]`);
      // Same table, its own key and a sliding window: the latest row says when the last success
      // was. The advisory lock serialises two attempts on one key, so exactly one sees no row;
      // rejected: the fixed window of `hit` with max 1 (two mails at 23:59 and 00:01 UTC).
      await sql`select pg_advisory_xact_lock(hashtextextended(${`rate:${tenantId}:${key}`}, 0))`.execute(
        trx
      );
      const now = clock.now();
      const recent = await trx
        .selectFrom('rate_limits')
        .select('hits')
        .where('tenant_id', '=', tenantId)
        .where('key', '=', key)
        .where('window_start', '>', new Date(now.getTime() - seconds * 1000))
        .executeTakeFirst();
      if (recent) return false;
      await trx
        .insertInto('rate_limits')
        .values({ tenant_id: tenantId, key, window_start: now, hits: 1 })
        .onConflict((oc) => oc.columns(['tenant_id', 'key', 'window_start']).doNothing())
        .execute();
      return true;
    },
  };
}

/**
 * Supporter log and projection (ADR 003, ADR 019). `lock` takes a transaction-scoped advisory
 * lock per (tenant, address); rejected: `select ... for update` on the projection row, which does
 * not exist yet for a first event, so two first events would both create a supporter.
 */
export function supporterRepository(trx: Trx, tenantId: string, ids: Ids): SupporterRepository {
  const toProjection = (row: Selectable<Database['supporters']>): SupporterProjection => ({
    id: row.id,
    email: row.email,
    firstSeen: new Date(row.first_seen).toISOString(),
    lastActivity: new Date(row.last_activity).toISOString(),
    lists: row.lists,
    pendingLists: row.pending_lists,
    appliedThrough: {
      at: new Date(row.applied_through_at).toISOString(),
      id: row.applied_through_id,
    },
  });
  return {
    async lock(email) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${email}`}, 0))`.execute(
        trx
      );
    },
    async resolve(email) {
      const row = await trx
        .selectFrom('supporters')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      return row ? { id: row.id, isNew: false } : { id: ids.next(), isNew: true };
    },
    async appendEvent(e) {
      const inserted = await trx
        .insertInto('events')
        .values({
          tenant_id: tenantId,
          id: e.id,
          supporter_id: e.supporter_id,
          schema: e.schema,
          type: e.type,
          email: e.email,
          occurred_at: e.occurred_at,
          source: e.source,
          source_site: e.source_site,
          source_ref: e.source_ref,
          props: JSON.stringify(e.props),
        })
        // The key includes occurred_at (partitioning); the id hashes it, so this is dedup on id.
        .onConflict((oc) => oc.columns(['tenant_id', 'id', 'occurred_at']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async eventsFor(supporterId) {
      const rows = await trx
        .selectFrom('events')
        .selectAll()
        .where('supporter_id', '=', supporterId)
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
      return row ? toProjection(row) : null;
    },
    async getProjectionById(id) {
      const row = await trx
        .selectFrom('supporters')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toProjection(row) : null;
    },
    async saveProjection(p) {
      const values = {
        email: p.email,
        first_seen: p.firstSeen,
        last_activity: p.lastActivity,
        lists: p.lists,
        pending_lists: p.pendingLists,
        applied_through_at: p.appliedThrough.at,
        applied_through_id: p.appliedThrough.id,
        updated_at: new Date(),
      };
      await trx
        .insertInto('supporters')
        .values({ tenant_id: tenantId, id: p.id, ...values })
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet(values))
        .execute();
    },
  };
}
