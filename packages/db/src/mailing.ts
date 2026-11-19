// Kysely implementation of the transactional mail intent port, under the tenant's RLS context.

import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type MailAutomation,
  type MailAutomationsRepository,
  type MailEdition,
  type MailEditionSummary,
  type MailEditionsRepository,
  type MailSend,
  type MailSendsRepository,
} from '@mycel/core';
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
    async attemptedSince(subscriber, since) {
      const row = await trx
        .selectFrom('mail_sends')
        .select(sql<string>`count(*)`.as('n'))
        .where('tenant_id', '=', tenantId)
        .where('subscriber', '=', subscriber)
        .where('attempted_at', '>=', since)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
  };
}

/**
 * Editions as they were sent (0070): one row per locale, inserted together. `mycel_app` may
 * move `delivered_through` and `completed_at` and nothing else, so no method here can change
 * what was sent.
 */
export function mailEditionsRepository(trx: Trx, tenantId: string): MailEditionsRepository {
  return {
    async insert(edition) {
      await trx
        .insertInto('mail_editions')
        .values(
          edition.locales.map((l) => ({
            tenant_id: tenantId,
            id: edition.id,
            locale: l.locale,
            item_id: edition.itemId,
            revision_id: l.revisionId,
            list: edition.list,
            subject: l.subject,
            html: l.html,
            text: l.text,
            recipients: edition.recipients,
            sent_at: edition.sentAt,
          }))
        )
        .execute();
    },
    async get(id) {
      const rows = await trx
        .selectFrom('mail_editions')
        .selectAll()
        .where('id', '=', id)
        .orderBy('locale')
        .execute();
      const first = rows[0];
      if (!first) return null;
      const edition: MailEdition = {
        id: first.id,
        itemId: first.item_id,
        list: first.list,
        recipients: first.recipients,
        sentAt: new Date(first.sent_at),
        deliveredThrough: first.delivered_through,
        completedAt: first.completed_at ? new Date(first.completed_at) : null,
        locales: rows.map((r) => ({
          locale: r.locale,
          revisionId: r.revision_id,
          subject: r.subject,
          html: r.html,
          text: r.text,
        })),
      };
      return edition;
    },
    async forItem(itemId) {
      // Index `mail_editions_item`; the mail itself stays in the table.
      const rows = await trx
        .selectFrom('mail_editions')
        .select(['id', 'list', 'recipients', 'sent_at', 'completed_at', 'locale', 'subject'])
        .where('item_id', '=', itemId)
        .orderBy('sent_at', 'desc')
        .orderBy('id', 'desc')
        .orderBy('locale')
        .execute();
      const editions = new Map<string, MailEditionSummary>();
      for (const r of rows) {
        const known = editions.get(r.id);
        if (known) known.locales.push({ locale: r.locale, subject: r.subject });
        else
          editions.set(r.id, {
            id: r.id,
            itemId,
            list: r.list,
            recipients: r.recipients,
            sentAt: new Date(r.sent_at),
            completedAt: r.completed_at ? new Date(r.completed_at) : null,
            locales: [{ locale: r.locale, subject: r.subject }],
          });
      }
      return [...editions.values()];
    },
    async advance(id, supporterId) {
      await trx
        .updateTable('mail_editions')
        .set({ delivered_through: supporterId })
        .where('id', '=', id)
        .execute();
    },
    async complete(id, at) {
      await trx
        .updateTable('mail_editions')
        .set({ completed_at: at })
        .where('id', '=', id)
        .where('completed_at', 'is', null)
        .execute();
    },
  };
}

/**
 * Welcome series (0082): one per list, steps replaced whole on save, one run per person. `start`
 * and `advance` are single conditional statements, so two workers on one event or one job
 * agree on who goes first.
 */
export function mailAutomationsRepository(trx: Trx, tenantId: string): MailAutomationsRepository {
  const load = async (
    rows: Selectable<Database['mail_automations']>[]
  ): Promise<MailAutomation[]> => {
    if (!rows.length) return [];
    const steps = await trx
      .selectFrom('mail_automation_steps')
      .selectAll()
      .where(
        'automation_id',
        'in',
        rows.map((r) => r.id)
      )
      .orderBy('position')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      list: r.list,
      enabled: r.enabled,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      steps: steps
        .filter((s) => s.automation_id === r.id)
        .map((s) => ({ itemId: s.item_id, delayDays: s.delay_days })),
    }));
  };
  const one = async (column: 'id' | 'list', value: string) =>
    (
      await load(
        await trx.selectFrom('mail_automations').selectAll().where(column, '=', value).execute()
      )
    )[0] ?? null;
  return {
    list: async () =>
      load(await trx.selectFrom('mail_automations').selectAll().orderBy('list').execute()),
    get: (id) => one('id', id),
    forList: (list) => one('list', list),
    async save(a) {
      await trx
        .insertInto('mail_automations')
        .values({
          tenant_id: tenantId,
          id: a.id,
          list: a.list,
          enabled: a.enabled,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'id'])
            .doUpdateSet({ enabled: a.enabled, updated_at: a.updatedAt })
        )
        .execute();
      await trx.deleteFrom('mail_automation_steps').where('automation_id', '=', a.id).execute();
      if (a.steps.length)
        await trx
          .insertInto('mail_automation_steps')
          .values(
            a.steps.map((step, position) => ({
              tenant_id: tenantId,
              automation_id: a.id,
              position,
              item_id: step.itemId,
              delay_days: step.delayDays,
            }))
          )
          .execute();
    },
    async start(automationId, supporterId, at) {
      const rows = await trx
        .insertInto('mail_automation_runs')
        .values({
          tenant_id: tenantId,
          automation_id: automationId,
          supporter_id: supporterId,
          started_at: at,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('supporter_id')
        .execute();
      return rows.length === 1;
    },
    async run(automationId, supporterId) {
      const row = await trx
        .selectFrom('mail_automation_runs')
        .selectAll()
        .where('automation_id', '=', automationId)
        .where('supporter_id', '=', supporterId)
        .executeTakeFirst();
      return row
        ? {
            automationId: row.automation_id,
            supporterId: row.supporter_id,
            startedAt: new Date(row.started_at),
            through: row.through,
          }
        : null;
    },
    async advance(automationId, supporterId, through) {
      const result = await trx
        .updateTable('mail_automation_runs')
        .set({ through })
        .where('automation_id', '=', automationId)
        .where('supporter_id', '=', supporterId)
        .where('through', '<', through)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async reach(automationId) {
      const { rows } = await sql<{ started: string; reached: number[] | null }>`
        select count(*)::text as started,
               (select array_agg(n order by p) from (
                  select s.position as p,
                         count(r.supporter_id) filter (where r.through >= s.position)::int as n
                  from mail_automation_steps s
                  left join mail_automation_runs r on r.automation_id = s.automation_id
                  where s.automation_id = ${automationId}
                  group by s.position) x) as reached
        from mail_automation_runs where automation_id = ${automationId}`.execute(trx);
      const row = rows[0];
      return { started: Number(row?.started ?? 0), reached: row?.reached ?? [] };
    },
  };
}
