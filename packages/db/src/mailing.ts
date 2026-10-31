// Kysely implementation of the transactional mail intent port, under the tenant's RLS context.

import { sql, type Kysely, type Selectable } from 'kysely';
import { type MailSend, type MailSendsRepository } from '@mycel/core';
import type { Database } from './infra/schema.js';

type Trx = Kysely<Database>;

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
    async daily(since, now, zone) {
      // One pass: each row lands on the day of the moment that decided its state. The zone is a
      // bound parameter, never spliced; Postgres refuses a name it does not know.
      const { rows } = await sql<{ day: string; sent: number; unknown: number; abandoned: number }>`
        with decided as (
          select
            case
              when sent_at is not null then 'sent'
              when abandoned_at is not null then 'abandoned'
              else 'unknown'
            end as state,
            coalesce(sent_at, abandoned_at, attempted_at) as at
          from mail_sends
          where tenant_id = ${tenantId}
            and (sent_at is not null or abandoned_at is not null
              or (attempted_at is not null
                and (claimed_until is null or claimed_until <= ${now})))
        )
        select
          to_char((at at time zone ${zone})::date, 'YYYY-MM-DD') as day,
          count(*) filter (where state = 'sent')::int as sent,
          count(*) filter (where state = 'unknown')::int as unknown,
          count(*) filter (where state = 'abandoned')::int as abandoned
        from decided
        where at >= ${since}
        group by 1
        order by 1
      `.execute(trx);
      return rows;
    },
  };
}
