// The erasure register over Postgres (TODO #18d, migration 0019; ADR 003 rule 5, ADR 019 rule 8).
// `register` writes one permanent row as mycel_app; `status` reads which of them a backup holds
// (0021, written by the backup login only). `apply` enters `mycel_erasure` for the rest of
// its statements, inside the caller's tenant transaction: that role may tombstone events and the
// projection, delete submissions, mail intents and jobs, and rewrite outbox props, each on the
// current tenant's rows only. Only the schema owner's login may enter it, so the worker and the CLI
// apply and a front that tries gets a clear refusal.
//
// The addresses to erase are not stored anywhere: apply finds them from the register each time, in
// the supporter's projection and events (by id) and in projections and submission values whose
// hash is registered (a restore can bring back a submission whose supporter was never ingested).
// They live in this process for the length of one call.
// Rejected: a security-definer function (the owner sees no tenant row under forced RLS), and
// matching every table by hash (one sha256 per row per call, where the id finds the same rows).

import { sql, type Kysely } from 'kysely';
import {
  ERASED_DOMAIN,
  erasureEmailHash,
  scrubText,
  systemPrincipal,
  type Clock,
  type Erasures,
  type Principal,
} from '@mycel/core';
import { withTenant } from './index.js';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

/** `erasureEmailHash` in SQL, over a column or value `x` of the current tenant's rows. */
const hashOf = (x: string) =>
  sql.raw(
    `encode(sha256(convert_to(tenant_id::text || E'\\n' || lower(btrim(${x})), 'UTF8')), 'hex')`
  );
const TOMB = sql.raw(`'@${ERASED_DOMAIN}'`);

export function erasureRepository(
  trx: Trx,
  tenantId: string,
  principal: Principal,
  clock: Clock
): Erasures {
  return {
    async register(supporterId, email) {
      await trx
        .insertInto('erasures')
        .values({
          tenant_id: tenantId,
          supporter_id: supporterId,
          email_hash: await erasureEmailHash(tenantId, email),
          erased_at: clock.now(),
          actor: JSON.stringify(principal.actor),
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'supporter_id']).doNothing())
        .execute();
    },

    async apply() {
      try {
        await sql`set local role mycel_erasure`.execute(trx);
      } catch (e) {
        throw new Error(
          'erasures can only be applied on the operator connection (the worker or `mycel erasures apply`), ' +
            `not as the fronts' login: ${(e as Error).message}`
        );
      }
      const changed = await applyAsEraser(trx);
      await sql`set local role mycel_app`.execute(trx);
      return changed;
    },

    async status() {
      // As mycel_app under the tenant's context: both tables are readable to it, its rows only.
      const { rows } = await sql<{ registered: string; secured: string; oldest: Date | null }>`
        select count(*) as registered, count(b.supporter_id) as secured,
               min(e.erased_at) filter (where b.supporter_id is null) as oldest
        from erasures e
        left join erasure_backups b using (tenant_id, supporter_id)`.execute(trx);
      const r = rows[0]!;
      return {
        registered: Number(r.registered),
        secured: Number(r.secured),
        oldestUnsecuredAt: r.oldest,
      };
    },
  };
}

async function applyAsEraser(trx: Trx): Promise<number> {
  const registered = await trx.selectFrom('erasures').select('supporter_id').execute();
  if (!registered.length) return 0;
  const ids = registered.map((r) => r.supporter_id);
  const addresses = (
    await sql<{ a: string }>`
      with reg as (select supporter_id, email_hash from erasures)
      select lower(btrim(email)) as a from supporters
        where id in (select supporter_id from reg) and email not like ${'%@' + ERASED_DOMAIN}
      union
      select lower(btrim(email)) from events
        where supporter_id in (select supporter_id from reg) and email not like ${'%@' + ERASED_DOMAIN}
      union
      select lower(btrim(email)) from supporters
        where ${hashOf('email')} in (select email_hash from reg)
      union
      select lower(btrim(v.value)) from form_submissions, jsonb_each_text("values") v
        where strpos(v.value, '@') > 0 and ${hashOf('v.value')} in (select email_hash from reg)`.execute(
      trx
    )
  ).rows.map((r) => r.a);
  const carries = (column: string) =>
    sql`exists (select from unnest(${addresses}::text[]) a where strpos(lower(${sql.raw(column)}::text), a) > 0)`;

  let changed = 0;
  const count = (r: { numAffectedRows?: bigint }) => (changed += Number(r.numAffectedRows ?? 0n));

  count(
    await sql`
      update events set email = supporter_id::text || ${TOMB}, props = '{}'::jsonb
      where (supporter_id = any(${ids}::uuid[]) or lower(email) = any(${addresses}::text[]))
        and not (email = supporter_id::text || ${TOMB} and props = '{}'::jsonb)`.execute(trx)
  );
  count(
    await sql`
      update supporters
      set email = id::text || ${TOMB}, lists = '{}', pending_lists = '{}', updated_at = now()
      where (id = any(${ids}::uuid[]) or lower(email) = any(${addresses}::text[]))
        and not (email = id::text || ${TOMB} and lists = '{}' and pending_lists = '{}')`.execute(
      trx
    )
  );
  if (!addresses.length) return changed;

  // Mail intents and their reconcile jobs hang off the outbox event that carried the address;
  // find them before the scrub below takes the address out of that event.
  const outbox = (
    await sql<{ id: string; props: Record<string, unknown> }>`
      select id, props from outbox where ${carries('props')}`.execute(trx)
  ).rows;
  const eventIds = outbox.map((e) => e.id);
  count(
    await sql`delete from mail_sends where event_id::text = any(${eventIds}::text[])`.execute(trx)
  );
  count(await sql`delete from form_submissions where ${carries('"values"')}`.execute(trx));
  for (const e of outbox)
    count(
      await sql`update outbox set props = ${scrubText(JSON.stringify(e.props))}::jsonb
                where id = ${e.id}`.execute(trx)
    );
  count(
    await sql`
      delete from jobs
      where ${carries('payload')}
         or (type = 'mail.reconcile' and payload->>'eventId' = any(${eventIds}::text[]))`.execute(
      trx
    )
  );
  return changed;
}

/** `mycel erasures status`: one tenant's register and how much of it a backup holds. */
export function erasureStatus(operatorDb: Kysely<Database>, tenantId: string) {
  const principal = systemPrincipal(tenantId, 'erasures');
  return withTenant(operatorDb, principal, (trx) =>
    erasureRepository(trx, tenantId, principal, { now: () => new Date() }).status()
  );
}

/**
 * `mycel erasures apply`: apply the register of one tenant in its own transaction on the operator
 * connection, which may enter mycel_erasure. Returns the rows changed.
 */
export function applyErasures(operatorDb: Kysely<Database>, tenantId: string): Promise<number> {
  const principal = systemPrincipal(tenantId, 'erasures');
  return withTenant(operatorDb, principal, (trx) =>
    erasureRepository(trx, tenantId, principal, { now: () => new Date() }).apply()
  );
}
