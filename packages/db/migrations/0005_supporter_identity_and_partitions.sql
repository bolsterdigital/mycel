-- 0005: stable supporter id and a monthly partitioned event log (ADR 019 rule 1, ADR 003
-- consequence 1 as amended 2026-10-21).
--
-- `supporters` is keyed by `(tenant_id, id)`; the e-mail address stays unique per tenant but may
-- change (`supporter.email_changed`). `events` carries `supporter_id` and is range-partitioned by
-- `occurred_at` per month. Partitioning forces `occurred_at` into the primary key; dedup on
-- `(tenant_id, id)` is unchanged because the deterministic id already hashes `occurred_at`.
-- Rejected: per-tenant sub-partitions (ADR 003 amendment) and an unpartitioned table until it is
-- big, which would mean rewriting the largest table under load later.
--
-- No foreign key from `events` to `supporters`: the log is the source of truth and the projection
-- is rebuildable from it, so the projection must be droppable without touching the log, and
-- ingest appends before it saves the projection.
--
-- Forward-only and data-preserving: the 0004 tables are renamed, copied with a fresh
-- `gen_random_uuid()` per address (dev data; production had no rows), and dropped.

alter table events rename to events_0004;
alter index events_pkey rename to events_0004_pkey;
alter index events_person rename to events_0004_person;
alter table supporters rename to supporters_0004;
alter index supporters_pkey rename to supporters_0004_pkey;
-- The migrating role owns these tables and is bound by forced RLS without a tenant context: it
-- would copy nothing. Unforced, the owner reads every tenant; the new tables are forced after the
-- copy, below.
alter table events_0004 no force row level security;
alter table supporters_0004 no force row level security;

create table supporters (
  tenant_id           uuid not null references tenants(id),
  id                  uuid not null,
  email               text not null,
  first_seen          timestamptz not null,
  last_activity       timestamptz not null,
  lists               text[] not null default '{}',
  -- Fold position of the last applied event (ADR 019 rule 2).
  applied_through_at  timestamptz not null,
  applied_through_id  text collate "C" not null,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, email)
);
alter table supporters enable row level security;
create policy tenant_isolation on supporters
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on supporters to mycel_app;

create table events (
  tenant_id     uuid not null references tenants(id),
  -- sha1(source|source_ref|type|occurred_at). Collation "C" so `order by id` in SQL is the same
  -- tie-break as fold order in the core (byte order, not the database locale).
  id            text collate "C" not null,
  supporter_id  uuid not null,
  schema        text not null,
  type          text not null,
  email         text not null,
  occurred_at   timestamptz not null,
  source        text not null,
  source_site   text not null,
  source_ref    text not null,
  props         jsonb not null default '{}',
  ingested_at   timestamptz not null default now(),
  primary key (tenant_id, id, occurred_at)
) partition by range (occurred_at);
create index events_supporter on events (tenant_id, supporter_id, occurred_at);
-- Catches rows outside the created months. Must stay empty (database conformance): a row here
-- blocks creating the partition for its month.
create table events_default partition of events default;
-- RLS, policy and grants live on the parent only. Queries through the parent apply them; the
-- partitions grant mycel_app nothing, so it cannot read around the policy.
alter table events enable row level security;
create policy tenant_isolation on events
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- Append-only for the application: no update, no delete (erasure is an operator path).
grant select, insert on events to mycel_app;

-- One partition per month in [from_month, to_month], idempotent. Migrate calls it after every run
-- (`ensureEventPartitions`), a backfill calls it with its own range before inserting.
create function ensure_event_partitions(from_month date, to_month date) returns integer
language plpgsql set search_path = public as $$
declare
  m date := date_trunc('month', from_month)::date;
  created integer := 0;
begin
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
revoke execute on function ensure_event_partitions(date, date) from public;

select ensure_event_partitions(
  least(date '2026-10-01', (select min(occurred_at at time zone 'UTC')::date from events_0004)),
  (now() at time zone 'UTC' + interval '3 months')::date
);

insert into supporters (tenant_id, id, email, first_seen, last_activity, lists,
                        applied_through_at, applied_through_id, updated_at)
select s.tenant_id, gen_random_uuid(), s.email, s.first_seen, s.last_activity, s.lists,
       coalesce(last.occurred_at, s.last_activity), coalesce(last.id, ''), s.updated_at
from supporters_0004 s
left join lateral (
  select e.occurred_at, e.id from events_0004 e
  where e.tenant_id = s.tenant_id and e.email = s.email
  order by e.occurred_at desc, e.id collate "C" desc
  limit 1
) last on true;

insert into events (tenant_id, id, supporter_id, schema, type, email, occurred_at, source,
                    source_site, source_ref, props, ingested_at)
select e.tenant_id, e.id, s.id, e.schema, e.type, e.email, e.occurred_at, e.source,
       e.source_site, e.source_ref, e.props, e.ingested_at
from events_0004 e
join supporters s on s.tenant_id = e.tenant_id and s.email = e.email;

do $$
begin
  if (select count(*) from events) <> (select count(*) from events_0004) then
    raise exception '0005: events without a supporter row in 0004, refusing to drop them';
  end if;
end $$;

drop table events_0004;
drop table supporters_0004;

alter table supporters force row level security;
alter table events force row level security;
