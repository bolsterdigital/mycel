-- 0004: the supporter event log and its projection (ADR 003).
--
-- ADR 003 says `events` is partitioned by tenant and month from the start. Not yet: with
-- partitioning the primary key must include occurred_at, which changes how dedup on the
-- deterministic id works. That trade-off deserves its own migration and test; the probe keeps a
-- plain table so the ingest path can be proven first.

create table events (
  tenant_id    uuid not null references tenants(id),
  id           text not null,                -- sha1(source|source_ref|type|occurred_at)
  schema       text not null,
  type         text not null,
  email        text not null,
  occurred_at  timestamptz not null,
  source       text not null,
  source_site  text not null,
  source_ref   text not null,
  props        jsonb not null default '{}',
  ingested_at  timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index events_person on events (tenant_id, email, occurred_at);
alter table events enable row level security;
alter table events force row level security;
create policy tenant_isolation on events
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
-- Append-only for the application: no update, no delete (erasure is an operator path).
grant select, insert on events to mycel_app;

create table supporters (
  tenant_id      uuid not null references tenants(id),
  email          text not null,
  first_seen     timestamptz not null,
  last_activity  timestamptz not null,
  lists          text[] not null default '{}',
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, email)
);
alter table supporters enable row level security;
alter table supporters force row level security;
create policy tenant_isolation on supporters
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on supporters to mycel_app;
