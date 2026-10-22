-- 0009: the jobs table, re-verification state on hostnames, and a partition function that
-- refuses to run over a filled default partition (TODO #15; ADR 011, ADR 012 rule 4, ADR 014
-- rule 2, ADR 018 rule 1).
--
-- `jobs` is the second queue next to the outbox and follows its discipline: a use case inserts
-- as mycel_app inside its own tenant transaction (so a job exists if and only if the change that
-- caused it committed), and the worker claims across tenants as mycel_worker with SKIP LOCKED.
-- Unlike the outbox, a claim is a lease (`claimed_at`) and the handler runs outside the claim
-- transaction, so a slow DNS lookup or partition DDL holds no row lock on the queue.
-- `tenant_id` null is a platform job: invisible to mycel_app, which cannot create one either.
-- Rejected: a separate mycel_scheduler role (same queue discipline, same role, ADR 011
-- consequences) and pg-boss or pg_cron (a dependency, or an extension managed Postgres does not
-- offer everywhere, for SQL we have to understand anyway).

create table jobs (
  id            uuid primary key,             -- UUIDv7, so ordering by id is by creation time
  tenant_id     uuid references tenants(id),  -- null: a platform job
  type          text not null,
  -- Deterministic and descriptive: `<type>:<subject>` or `<type>:<period>`. A tenant job's
  -- subject must be globally unique (an item id), because the key is; a subject that can move
  -- between tenants (a hostname) carries the tenant id, so a job left open by the previous
  -- owner never blocks the new owner's.
  key           text not null,
  run_at        timestamptz not null,
  payload       jsonb not null default '{}',
  attempts      integer not null default 0,
  max_attempts  integer not null default 10,
  -- The lease: set by the claim, cleared by a failure; older than five minutes is free again.
  claimed_at    timestamptz,
  done_at       timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
-- One open job per key; a finished job does not block the next one with the same key.
create unique index jobs_open_key on jobs (key) where done_at is null;
create index jobs_due on jobs (run_at, id) where done_at is null;

alter table jobs enable row level security;
alter table jobs force row level security;
create policy tenant_isolation on jobs
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- Scheduling, never reading or changing: the outbox grant (0003).
grant insert on jobs to mycel_app;

grant select, insert, update on jobs to mycel_worker;
create policy worker_jobs on jobs to mycel_worker using (true) with check (true);

-- Daily re-verification of custom hostnames (`hostnames.reverify`): consecutive checks that did
-- not find the TXT record, and when the last check that reached DNS ran.
alter table tenant_hostnames
  add column check_failures integer not null default 0,
  add column last_checked_at timestamptz;

-- Same signature and grants as 0005, plus a guard: a month whose rows already sit in
-- `events_default` cannot get its partition (Postgres refuses to attach over them), so say which
-- month, how many rows and how to recover instead of failing on DDL halfway through a range.
-- The check runs over the whole range before anything is created. Moving the rows is an
-- operator decision, never automatic.
create or replace function ensure_event_partitions(from_month date, to_month date) returns integer
language plpgsql set search_path = public as $$
declare
  m date;
  lo text;
  hi text;
  stray bigint;
  created integer := 0;
begin
  m := date_trunc('month', from_month)::date;
  while m <= date_trunc('month', to_month)::date loop
    if to_regclass(format('public.events_%s', to_char(m, 'YYYY_MM'))) is null then
      lo := m::text || ' 00:00:00+00';
      hi := (m + interval '1 month')::date::text || ' 00:00:00+00';
      select count(*) into stray from events_default
        where occurred_at >= lo::timestamptz and occurred_at < hi::timestamptz;
      if stray > 0 then
        raise exception '%', format(
          'events_default holds %s row(s) from %s, so their partition cannot be created. Move '
          'them in one transaction as the schema owner: create temp table moved as select * from '
          'events_default where occurred_at >= %L and occurred_at < %L; delete from '
          'events_default where occurred_at >= %L and occurred_at < %L; select '
          'ensure_event_partitions(%L, %L); insert into events select * from moved;',
          stray, to_char(m, 'YYYY-MM'), lo, hi, lo, hi, m, m);
      end if;
    end if;
    m := (m + interval '1 month')::date;
  end loop;

  m := date_trunc('month', from_month)::date;
  while m <= date_trunc('month', to_month)::date loop
    if to_regclass(format('public.events_%s', to_char(m, 'YYYY_MM'))) is null then
      execute format(
        'create table %I partition of events for values from (%L) to (%L)',
        format('events_%s', to_char(m, 'YYYY_MM')),
        m::text || ' 00:00:00+00',
        (m + interval '1 month')::date::text || ' 00:00:00+00'
      );
      created := created + 1;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return created;
end $$;
