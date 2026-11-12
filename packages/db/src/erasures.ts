// The erasure register over Postgres (TODO #18d, migration 0019; ADR 003 rule 5, ADR 019 rule 8).
// `register` writes one permanent row as mycel_app; `status` reads which of them a backup holds
// (0021, written by the backup login only). `apply` enters `mycel_erasure` for the rest of
// its statements, inside the caller's tenant transaction: that role may tombstone events and the
// projection, delete submissions, mail intents, jobs and admission seats (0032), rewrite outbox
// props and expire export archives (0022), each on the current tenant's rows only. Only the schema owner's login may enter it, so the worker and the CLI
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
  carriesErasedAddress,
  liveLifecycle,
  protectsErasureCopy,
  isTombstone,
  normalizeEmail,
  eraseOutboxProps,
  ERASED_DOMAIN,
  ERASURE_EXPIRES_EXPORTS,
  ERASURE_EXPORT_ERROR,
  ERASURE_KEEPS_INTENT_STATES,
  emailKey,
  systemPrincipal,
  type Clock,
  type Erasures,
  type Principal,
} from '@mycel/core';
import { withTenant } from './index.js';
import type { Database } from './infra/schema.js';
import { lifecycleEvidence, lifecycleRepository, lockSupporter } from './supporters/lifecycle.js';
import { advisoryLock, setRole } from './infra/roles.js';
import { applyPersonErasures } from './person-erasures.js';

type Trx = Kysely<Database>;

const TOMB = sql.raw(`'@${ERASED_DOMAIN}'`);

export function erasureRepository(
  trx: Trx,
  tenantId: string,
  principal: Principal,
  clock: Clock
): Erasures {
  return {
    ...lifecycleRepository(trx, tenantId),
    async register(supporterId, email) {
      await lockSupporter(trx, tenantId, email);
      await trx
        .insertInto('erasures')
        .values({
          tenant_id: tenantId,
          supporter_id: supporterId,
          email_hash: await emailKey(tenantId, email, 'erasure'),
          erased_at: clock.now(),
          actor: JSON.stringify(principal.actor),
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'supporter_id']).doNothing())
        .execute();
    },

    async get(supporterId) {
      const row = await trx
        .selectFrom('erasures as e')
        .leftJoin('erasure_backups as b', (j) =>
          j.onRef('b.tenant_id', '=', 'e.tenant_id').onRef('b.supporter_id', '=', 'e.supporter_id')
        )
        .select(['e.erased_at', 'b.supporter_id as secured'])
        .where('e.supporter_id', '=', supporterId)
        .executeTakeFirst();
      return row ? { registeredAt: row.erased_at, secured: row.secured !== null } : null;
    },

    async apply() {
      try {
        await setRole(trx, 'mycel_erasure');
      } catch (e) {
        throw new Error(
          'erasures can only be applied on the operator connection (the worker or `mycel erasures apply`), ' +
            `not as the fronts' login: ${(e as Error).message}`
        );
      }
      const hashes = await trx
        .selectFrom('erasures')
        .select('email_hash')
        .distinct()
        .orderBy('email_hash')
        .execute();
      for (const { email_hash } of hashes)
        await advisoryLock(trx, 'supporter', tenantId, email_hash);
      const locked = new Set(hashes.map((r) => r.email_hash));
      // ADR 034: the person phase runs in the same per-tenant run; the supporter phase is unchanged.
      let changed = locked.size ? await eraseRows(trx, tenantId, locked) : 0;
      changed += await applyPersonErasures(trx);
      changed += await expireExports(trx, changed > 0, locked);
      await setRole(trx, 'mycel_app');
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

/**
 * Core `expiresOnErasure` as one statement: every archive asked for before the newest
 * registration of either register, or every one when this apply changed anything. The file goes
 * after commit (`expireExports`, run by `mycel erasures apply` and daily by the worker); the row
 * keeps no trace of who.
 */
async function expireExports(
  trx: Trx,
  changedRows: boolean,
  lockedHashes: ReadonlySet<string>
): Promise<number> {
  const r = await sql`
    update tenant_exports
    set status = 'expired', error = ${ERASURE_EXPORT_ERROR}, expires_at = now()
    where status = any(${[...ERASURE_EXPIRES_EXPORTS]}::text[])
      and (${changedRows} or requested_at < greatest(
        (select max(erased_at) from erasures where email_hash = any(${[...lockedHashes]}::text[])),
        (select max(erased_at) from person_erasures)))`.execute(trx);
  return Number(r.numAffectedRows ?? 0n);
}

async function eraseRows(
  trx: Trx,
  tenantId: string,
  lockedHashes: ReadonlySet<string>
): Promise<number> {
  const evidence = await lifecycleEvidence(trx);
  const registrations = evidence.registrations.filter((r) => lockedHashes.has(r.emailHash));
  const lifecycles = evidence.lifecycles;
  const registered = registrations.map((r) => ({
    supporter_id: r.supporterId,
    email_hash: r.emailHash,
  }));
  const live = new Map(
    lifecycles.filter((l) => liveLifecycle(l, registrations)).map((l) => [l.id, l])
  );
  if (!registered.length) return 0;
  const ids = registered.map((r) => r.supporter_id);
  const receiptChanges = await trx
    .deleteFrom('mailchimp_receipts')
    .where('supporter_id', 'in', ids)
    .executeTakeFirst();
  // No address or provider payload is stored. Detach the pseudonymous supporter reference while
  // retaining honest external uncertainty; an erasure never claims the provider deleted a copy.
  // Core `erasedIntentState` as one statement.
  const intentChanges = await sql`update connection_intents set supporter_id = null,
    state = case when state = any(${[...ERASURE_KEEPS_INTENT_STATES]}::text[]) then state
                 else 'blocked' end,
    failure = 'erasure', lease_token = null, lease_until = null, revision = revision + 1
    where supporter_id = any(${ids}::uuid[])`.execute(trx);
  // Use core's normalisation and hash for restored data too. SQL lower/btrim differs from
  // JavaScript for Unicode spaces and case mappings. These tenant-bound scans replace the old
  // SQL substring scans; decoded JSON also avoids treating serialization escapes as delimiters.
  const hashes = new Set(registered.map((r) => r.email_hash));
  const supporters = await trx.selectFrom('supporters').select(['id', 'email']).execute();
  const events = await trx.selectFrom('events').select(['id', 'supporter_id', 'email']).execute();
  const submissions = await trx
    .selectFrom('form_submissions')
    .select(['id', 'values', 'evaluation'])
    .execute();
  const addresses = new Set<string>();
  const consider = async (email: string, owner?: string | null) => {
    if (isTombstone(email)) return;
    if (ids.includes(owner ?? '') || hashes.has(await emailKey(tenantId, email, 'erasure')))
      addresses.add(normalizeEmail(email));
  };
  for (const row of supporters) await consider(row.email, row.id);
  for (const row of events) await consider(row.email, row.supporter_id);
  for (const row of submissions)
    for (const value of Object.values(row.values))
      if (typeof value === 'string' && value.includes('@')) await consider(value);
  const carries = (value: unknown) => carriesErasedAddress(value, addresses);
  const addressHashes = new Map(
    await Promise.all(
      [...addresses].map(async (a) => [a, await emailKey(tenantId, a, 'erasure')] as const)
    )
  );
  const proven = (value: unknown, provenance: unknown) =>
    protectsErasureCopy(value, provenance, live, addressHashes);
  const supporterIds = supporters
    .filter(
      (row) =>
        !live.has(row.id) && (ids.includes(row.id) || addresses.has(normalizeEmail(row.email)))
    )
    .map((row) => row.id);
  const eventRowIds = events
    .filter(
      (row) =>
        !live.has(row.supporter_id ?? '') &&
        (ids.includes(row.supporter_id ?? '') || addresses.has(normalizeEmail(row.email)))
    )
    .map((row) => row.id);

  let changed = Number(intentChanges.numAffectedRows ?? 0n) + Number(receiptChanges.numDeletedRows);
  const count = (r: { numAffectedRows?: bigint }) => (changed += Number(r.numAffectedRows ?? 0n));

  count(
    await sql`
      update events set email = supporter_id::text || ${TOMB}, props = '{}'::jsonb
      where id = any(${eventRowIds}::text[])
        and not (email = supporter_id::text || ${TOMB} and props = '{}'::jsonb)`.execute(trx)
  );
  count(
    await sql`
      update supporters
      set email = id::text || ${TOMB}, lists = '{}', pending_lists = '{}', updated_at = now()
      where id = any(${supporterIds}::uuid[])
        and not (email = id::text || ${TOMB} and lists = '{}' and pending_lists = '{}')`.execute(
      trx
    )
  );
  // ADR 033 rule 8: an erased supporter's participations go, and the confirmed, non-withdrawn
  // ones join the campaign's anonymous count in the same statement, so the public number never
  // drops and a rebuild from the remaining rows gives it back. A second apply finds no rows.
  const participations = await sql<{ deleted: string }>`
    with gone as (
      delete from campaign_participations where supporter_id = any(${supporterIds}::uuid[])
      returning campaign_id, withdrawn_at
    ), counted as (
      select campaign_id, count(*)::int as n from gone where withdrawn_at is null
      group by campaign_id
    ), bumped as (
      update campaigns c set erased_count = c.erased_count + counted.n
      from counted where c.id = counted.campaign_id
      returning c.id
    )
    select count(*)::text as deleted from gone`.execute(trx);
  changed += Number(participations.rows[0]?.deleted ?? 0);
  if (!addresses.size) return changed;

  // Mail intents and their reconcile jobs hang off the outbox event that carried the address;
  // find them before the scrub below takes the address out of that event.
  const outboxCandidates = (
    await sql<{ id: string; type: string; props: Record<string, unknown> }>`
      select id, type, props from outbox`.execute(trx)
  ).rows.filter((row) => carries(row.props));
  const outbox = [];
  for (const row of outboxCandidates) if (!proven(row.props, row.props)) outbox.push(row);
  const eventIds = outbox.map((e) => e.id);
  count(
    await sql`delete from mail_sends where event_id::text = any(${eventIds}::text[])`.execute(trx)
  );
  const submissionIds = submissions
    .filter((row) => carries(row.values) && !proven(row.values, row.evaluation))
    .map((row) => row.id);
  count(
    await sql`delete from form_submissions where id = any(${submissionIds}::uuid[])`.execute(trx)
  );
  // A seat reserved for a signup that was never ingested, under core's admission key.
  // A rate-limit bucket stays: a hash that lives a day at most is no copy (ADR 019 rule 8).
  const seats: string[] = [];
  for (const a of addresses) {
    const hash = await emailKey(tenantId, a, 'erasure');
    if (![...live.values()].some((l) => l.emailHash === hash))
      seats.push(await emailKey(tenantId, a, 'admission'));
  }
  count(
    await sql`delete from supporter_admissions where email_hash = any(${seats}::text[])`.execute(
      trx
    )
  );
  for (const e of outbox)
    count(
      await sql`update outbox set props = ${JSON.stringify(eraseOutboxProps(e.type, e.props))}::jsonb
                where id = ${e.id}`.execute(trx)
    );
  const jobs = await trx.selectFrom('jobs').select(['id', 'payload', 'type']).execute();
  const jobIds = jobs
    .filter(
      (row) =>
        carries(row.payload) ||
        (row.type === 'mail.reconcile' &&
          row.payload !== null &&
          typeof row.payload === 'object' &&
          'eventId' in row.payload &&
          typeof row.payload.eventId === 'string' &&
          eventIds.includes(row.payload.eventId))
    )
    .map((row) => row.id);
  count(await sql`delete from jobs where id = any(${jobIds}::uuid[])`.execute(trx));
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
