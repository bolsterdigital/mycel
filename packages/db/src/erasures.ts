// The erasure register over Postgres (TODO #18d, migration 0019; ADR 003 rule 5, ADR 019 rule 8).
// `register` writes one permanent row as mycel_app; `status` reads which of them a backup holds
// (0021, written by the backup login only). `apply` enters `mycel_erasure` for the rest of
// its statements, inside the caller's tenant transaction: that role may tombstone events and the
// projection, delete submissions, mail intents, jobs and admission seats (0032), rewrite outbox
// props and expire export archives (0022), each on the current tenant's rows only. Only the
// schema owner's login may enter it, so the worker and the CLI apply and a front that tries gets
// a clear refusal.
//
// The addresses to erase are not stored anywhere: apply finds them from the register each time, in
// the supporter's projection and events (by id) and in projections and submission values whose
// hash is registered (a restore can bring back a submission whose supporter was never ingested).
// They live in this process for the length of one call.
//
// Scale: apply first asks which registrations still have such a copy (`pendingHashes`) and
// locks and applies only those, `APPLY_BATCH` per transaction; a settled register costs one
// read per table and no lock. SQL hashes the text it can hash exactly (`plain`) to narrow what
// is read; core's `emailKey` decides on everything it reads.
// Rejected: a security-definer function (the owner sees no tenant row under forced RLS); a
// watermark of the previous run (a restore brings back old rows under old timestamps); and one
// lock per registration in one transaction (the shared lock table ran out between 10,000 and
// 15,000 registrations).

import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  erasedAddressMatcher,
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
import { applyPersonErasures } from './people/erasures.js';

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
      await enterErasure(trx);
      const pending = await pendingHashes(trx, tenantId);
      const changed = await applyHashes(trx, tenantId, pending, true);
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
 * Registrations one transaction locks and applies at most. Each holds one advisory lock
 * until commit, from a lock table every session of the cluster shares; at 64 locks per connection
 * slot a run of 15,000 failed with `out of shared memory`.
 */
export const APPLY_BATCH = 1000;

async function enterErasure(trx: Trx): Promise<void> {
  try {
    await setRole(trx, 'mycel_erasure');
  } catch (e) {
    throw new Error(
      'erasures can only be applied on the operator connection (the worker or `mycel erasures apply`), ' +
        `not as the fronts' login: ${(e as Error).message}`
    );
  }
}

/**
 * Lock the given registrations' addresses (sorted, as every other holder takes one) and apply
 * them; the person phase once per run. Returns the rows changed.
 */
async function applyHashes(
  trx: Trx,
  tenantId: string,
  hashes: readonly string[],
  personPhase: boolean
): Promise<number> {
  for (const hash of hashes) await advisoryLock(trx, 'supporter', tenantId, hash);
  // ADR 034: the person phase runs in the same per-tenant run; the supporter phase is unchanged.
  let changed = hashes.length ? await eraseRows(trx, tenantId, new Set(hashes)) : 0;
  if (personPhase) changed += await applyPersonErasures(trx);
  changed += await expireExports(trx, changed > 0);
  return changed;
}

/**
 * Core `expiresOnErasure` as one statement: every archive asked for before the newest
 * registration of either register, or every one when this apply changed anything. The file goes
 * after commit (`expireExports`, run by `mycel erasures apply` and daily by the worker); the row
 * keeps no trace of who.
 */
async function expireExports(trx: Trx, changedRows: boolean): Promise<number> {
  const r = await sql`
    update tenant_exports
    set status = 'expired', error = ${ERASURE_EXPORT_ERROR}, expires_at = now()
    where status = any(${[...ERASURE_EXPIRES_EXPORTS]}::text[])
      and (${changedRows} or requested_at < greatest(
        (select max(erased_at) from erasures),
        (select max(erased_at) from person_erasures)))`.execute(trx);
  return Number(r.numAffectedRows ?? 0n);
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Core `normalizeEmail` (trim, then lower case) is the identity on text of ASCII characters that
 * neither starts nor ends with a control character or space, apart from A-Z; SQL's own `lower`
 * and `btrim` differ from JavaScript beyond that. Text outside this class goes to core instead.
 */
export const plain = (v: RawBuilder<unknown>) =>
  sql`(octet_length(${v}) = char_length(${v}) and ascii(${v}) > 32 and ascii(right(${v}, 1)) > 32)`;

/** Core `emailKey(tenantId, v, 'erasure')` in SQL, exact for `plain` text only. */
export const sqlKey = (tenantId: string, v: RawBuilder<unknown>) =>
  sql`encode(sha256(convert_to(${tenantId}::text || chr(10) || translate(${v}, ${UPPER}, ${UPPER.toLowerCase()}), 'UTF8')), 'hex')`;

const TOMBSTONE_LIKE = `%@${ERASED_DOMAIN}`;

/** The registrations' hashes whose next apply has something to change, sorted. */
export async function pendingHashes(trx: Trx, tenantId: string): Promise<string[]> {
  const v = sql.ref('v');
  // By id: what eraseRows changes for a registered supporter id, unless it already did.
  // By address: an untombstoned copy whose address is registered; that is where eraseRows finds
  // the addresses whose other copies (outbox, jobs, submissions, seats) it then removes. Once none
  // is left it cannot find them either, so a settled registration is skipped without changing
  // what apply erases.
  // Lookups by id go through each table's (tenant_id, supporter id) index with the ids as one
  // array, so the plan does not hang on row estimates (a join planned as a nested loop on a fresh
  // tenant read every row once per registration).
  const register = await trx
    .selectFrom('erasures')
    .select(['supporter_id', 'email_hash'])
    .execute();
  if (!register.length) return [];
  const ids = register.map((r) => r.supporter_id);
  const byId = await sql<{ id: string }>`
    select id from supporters where id = any(${ids}::uuid[])
      and not (email = id::text || ${TOMB} and lists = '{}' and pending_lists = '{}')
    union
    select supporter_id from events where supporter_id = any(${ids}::uuid[])
      and not (email = supporter_id::text || ${TOMB} and props = '{}'::jsonb)
    union
    select supporter_id from mailchimp_receipts where supporter_id = any(${ids}::uuid[])
    union
    select supporter_id from connection_intents where supporter_id = any(${ids}::uuid[])
    union
    select supporter_id from campaign_participations where supporter_id = any(${ids}::uuid[])`.execute(
    trx
  );
  const open = new Set(byId.rows.map((r) => r.id));
  const pending = new Set(
    register.filter((r) => open.has(r.supporter_id)).map((r) => r.email_hash)
  );
  const registered = new Set(register.map((r) => r.email_hash));
  // Every distinct address-shaped value once, hashed by SQL where it can and returned as text
  // where it cannot; the comparison with the register happens here. Rejected: comparing in SQL
  // (`in (select unnest(...))`): on a freshly filled tenant the planner made that a nested loop
  // that hashed every value once per registration (20 minutes for 30,000).
  const { rows } = await sql<{ k: string | null; v: string | null }>`
    with copies as (
      select email as v from supporters where email not like ${TOMBSTONE_LIKE}
      union
      select email from events where email not like ${TOMBSTONE_LIKE}
      union
      select t.value #>> '{}' from form_submissions f
        cross join lateral jsonb_each(f.values) t
        where jsonb_typeof(f.values) = 'object' and jsonb_typeof(t.value) = 'string'
          and strpos(t.value #>> '{}', '@') > 0 and t.value #>> '{}' not like ${TOMBSTONE_LIKE}
    )
    select case when ${plain(v)} then ${sqlKey(tenantId, v)} end as k,
           case when ${plain(v)} then null else v end as v
    from copies`.execute(trx);
  const others: string[] = [];
  for (const r of rows) {
    if (r.k !== null && registered.has(r.k)) pending.add(r.k);
    if (r.v !== null) others.push(r.v);
  }
  // Submissions whose values are no object: core reads their entries the same way.
  const odd = await sql<{ values: unknown }>`
    select values from form_submissions where jsonb_typeof(values) <> 'object'`.execute(trx);
  for (const row of odd.rows)
    for (const value of Object.values(row.values ?? {}))
      if (typeof value === 'string' && value.includes('@') && !isTombstone(value))
        others.push(value);
  for (const value of others) {
    const hash = await emailKey(tenantId, value, 'erasure');
    if (registered.has(hash)) pending.add(hash);
  }
  return [...pending].sort();
}

async function eraseRows(
  trx: Trx,
  tenantId: string,
  lockedHashes: ReadonlySet<string>
): Promise<number> {
  const evidence = await lifecycleEvidence(trx);
  const registrations = evidence.registrations.filter((r) => lockedHashes.has(r.emailHash));
  const lifecycles = evidence.lifecycles;
  // Against the whole register, as when every registration was locked: a lifecycle that a
  // registration outside this batch ended protects nothing in it either.
  const live = new Map(
    lifecycles.filter((l) => liveLifecycle(l, evidence.registrations)).map((l) => [l.id, l])
  );
  if (!registrations.length) return 0;
  const ids = new Set(registrations.map((r) => r.supporterId));
  const idList = [...ids];
  const receiptChanges = await trx
    .deleteFrom('mailchimp_receipts')
    .where(sql<boolean>`supporter_id = any(${idList}::uuid[])`)
    .executeTakeFirst();
  // No address or provider payload is stored. Detach the pseudonymous supporter reference while
  // retaining honest external uncertainty; an erasure never claims the provider deleted a copy.
  // Core `erasedIntentState` as one statement.
  const intentChanges = await sql`update connection_intents set supporter_id = null,
    state = case when state = any(${[...ERASURE_KEEPS_INTENT_STATES]}::text[]) then state
                 else 'blocked' end,
    failure = 'erasure', lease_token = null, lease_until = null, revision = revision + 1
    where supporter_id = any(${idList}::uuid[])`.execute(trx);
  // Use core's normalisation and hash for every address taken: SQL lower/btrim differs from
  // JavaScript for Unicode spaces and case mappings, so SQL only narrows the rows read (`plain`,
  // `sqlKey`) and core decides. Decoded JSON also avoids treating serialization escapes as
  // delimiters.
  const hashes = new Set(registrations.map((r) => r.emailHash));
  const addresses = new Set<string>();
  const consider = async (email: string, owner?: string | null) => {
    if (isTombstone(email)) return;
    if (ids.has(owner ?? '') || hashes.has(await emailKey(tenantId, email, 'erasure')))
      addresses.add(normalizeEmail(email));
  };
  // The registered ids' own rows first: an address they carry joins the set even when it is not
  // the registered one, and every other row with that address goes as well.
  const byId = {
    supporters: await trx
      .selectFrom('supporters')
      .select(['id', 'email'])
      .where(sql<boolean>`id = any(${idList}::uuid[])`)
      .execute(),
    events: await trx
      .selectFrom('events')
      .select(['id', 'supporter_id', 'email'])
      .where(sql<boolean>`supporter_id = any(${idList}::uuid[])`)
      .execute(),
  };
  for (const row of byId.supporters) await consider(row.email, row.id);
  for (const row of byId.events) await consider(row.email, row.supporter_id);
  const keys = new Set(hashes);
  for (const a of addresses) keys.add(await emailKey(tenantId, a, 'erasure'));
  const keyList = [...keys];
  const v = (column: string) => sql.ref(column);
  // Under the `or`, Postgres cannot turn the `in` into a join it might plan as a nested loop; it
  // stays a subplan hashed once, with at most a batch's keys plus the ids' own addresses.
  const byAddress = (column: string) =>
    sql<boolean>`(not ${plain(v(column))} or ${sqlKey(tenantId, v(column))} in (select unnest(${keyList}::text[])))`;
  const seen = {
    supporters: new Set(byId.supporters.map((r) => r.id)),
    events: new Set(byId.events.map((r) => r.id)),
  };
  const supporterMatches = (
    await trx.selectFrom('supporters').select(['id', 'email']).where(byAddress('email')).execute()
  ).filter((row) => !seen.supporters.has(row.id));
  const eventMatches = (
    await trx
      .selectFrom('events')
      .select(['id', 'supporter_id', 'email'])
      .where(byAddress('email'))
      .execute()
  ).filter((row) => !seen.events.has(row.id));
  for (const row of supporterMatches) await consider(row.email, row.id);
  for (const row of eventMatches) await consider(row.email, row.supporter_id);
  const supporters = [...byId.supporters, ...supporterMatches];
  const events = [...byId.events, ...eventMatches];
  const values = await sql<{ v: string }>`
    select v from (
      select t.value #>> '{}' as v from form_submissions f
        cross join lateral jsonb_each(f.values) t
        where jsonb_typeof(f.values) = 'object' and jsonb_typeof(t.value) = 'string'
    ) x where strpos(v, '@') > 0 and ${byAddress('v')}`.execute(trx);
  for (const { v: value } of values.rows) if (value.includes('@')) await consider(value);
  const odd = await sql<{ values: unknown }>`
    select values from form_submissions where jsonb_typeof(values) <> 'object'`.execute(trx);
  for (const row of odd.rows)
    for (const value of Object.values(row.values ?? {}))
      if (typeof value === 'string' && value.includes('@')) await consider(value);

  const carries = erasedAddressMatcher(addresses);
  const addressHashes = new Map(
    await Promise.all(
      [...addresses].map(async (a) => [a, await emailKey(tenantId, a, 'erasure')] as const)
    )
  );
  const proven = (value: unknown, provenance: unknown) =>
    protectsErasureCopy(value, provenance, live, addressHashes);
  const supporterIds = supporters
    .filter(
      (row) => !live.has(row.id) && (ids.has(row.id) || addresses.has(normalizeEmail(row.email)))
    )
    .map((row) => row.id);
  const eventRowIds = events
    .filter(
      (row) =>
        !live.has(row.supporter_id ?? '') &&
        (ids.has(row.supporter_id ?? '') || addresses.has(normalizeEmail(row.email)))
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

  // Copies that carry an address anywhere, also inside free text: only rows whose JSON holds an
  // `@` can (jsonb escapes no `@`). Outbox and jobs have no tenant index that mycel_erasure may
  // use, so they are read here only, when there is something to erase, never on a settled run.
  // Mail intents and their reconcile jobs hang off the outbox event that carried the address;
  // find them before the scrub below takes the address out of that event.
  const outboxCandidates = (
    await sql<{ id: string; type: string; props: Record<string, unknown> }>`
      select id, type, props from outbox
        where tenant_id = ${tenantId} and strpos(props::text, '@') > 0`.execute(trx)
  ).rows.filter((row) => carries(row.props));
  const outbox = [];
  for (const row of outboxCandidates) if (!proven(row.props, row.props)) outbox.push(row);
  const eventIds = outbox.map((e) => e.id);
  count(
    await sql`delete from mail_sends where event_id::text = any(${eventIds}::text[])`.execute(trx)
  );
  const submissions = await sql<{ id: string; values: unknown; evaluation: unknown }>`
    select id, values, evaluation from form_submissions
      where strpos(values::text, '@') > 0`.execute(trx);
  const submissionIds = submissions.rows
    .filter((row) => carries(row.values) && !proven(row.values, row.evaluation))
    .map((row) => row.id);
  count(
    await sql`delete from form_submissions where id = any(${submissionIds}::uuid[])`.execute(trx)
  );
  // A seat reserved for a signup that was never ingested, under core's admission key.
  // A rate-limit bucket stays: a hash that lives a day at most is no copy (ADR 019 rule 8).
  const liveHashes = new Set([...live.values()].map((l) => l.emailHash));
  const seats: string[] = [];
  for (const [a, hash] of addressHashes)
    if (!liveHashes.has(hash)) seats.push(await emailKey(tenantId, a, 'admission'));
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
  const reconciles = new Set(eventIds);
  const jobs = await sql<{ id: string; payload: unknown; type: string }>`
    select id, payload, type from jobs
      where tenant_id = ${tenantId} and (strpos(payload::text, '@') > 0 or type = 'mail.reconcile')`.execute(
    trx
  );
  const jobIds = jobs.rows
    .filter(
      (row) =>
        carries(row.payload) ||
        (row.type === 'mail.reconcile' &&
          row.payload !== null &&
          typeof row.payload === 'object' &&
          'eventId' in row.payload &&
          typeof row.payload.eventId === 'string' &&
          reconciles.has(row.payload.eventId))
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
 * `mycel erasures apply`: apply the register of one tenant on the operator connection, which may
 * enter mycel_erasure. Returns the rows changed. The registrations with something left to change
 * go in transactions of at most `APPLY_BATCH`: each commits what it erased, and one that
 * fails leaves the rest to the next run, which finds the same work from the register.
 */
export async function applyErasures(
  operatorDb: Kysely<Database>,
  tenantId: string,
  batch = APPLY_BATCH
): Promise<number> {
  const principal = systemPrincipal(tenantId, 'erasures');
  const run = <T>(fn: (trx: Trx) => Promise<T>) =>
    withTenant(operatorDb, principal, async (trx) => {
      await enterErasure(trx);
      const result = await fn(trx);
      await setRole(trx, 'mycel_app');
      return result;
    });
  const first = await run(async (trx) => {
    const pending = await pendingHashes(trx, tenantId);
    return {
      pending,
      changed: await applyHashes(trx, tenantId, pending.slice(0, batch), true),
    };
  });
  let changed = first.changed;
  for (let i = batch; i < first.pending.length; i += batch) {
    const hashes = first.pending.slice(i, i + batch);
    changed += await run((trx) => applyHashes(trx, tenantId, hashes, false));
  }
  return changed;
}
