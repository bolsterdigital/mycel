-- 0003: the transactional outbox (ADR 008: queues start as Postgres tables with SKIP LOCKED).
-- Use cases insert here inside their tenant transaction as mycel_app; the worker drains across
-- tenants as mycel_worker, a role whose only cross-tenant power is this one table.
--
-- Why a dedicated role and not BYPASSRLS on the operator: BYPASSRLS needs a superuser to grant
-- and opens every table; a policy scoped to one role and one table is the smallest hole.

create table outbox (
  id            uuid primary key,             -- the event id (UUIDv7, so ordering is by time)
  tenant_id     uuid not null references tenants(id),
  type          text not null,
  occurred_at   timestamptz not null,
  actor         jsonb not null,
  props         jsonb not null,
  created_at    timestamptz not null default now(),
  available_at  timestamptz not null default now(),
  attempts      integer not null default 0,
  -- Subscribers that have handled this event; a retry skips them (at-least-once per subscriber).
  delivered_to  text[] not null default '{}',
  processed_at  timestamptz,
  last_error    text
);
create index outbox_pending on outbox (available_at, id) where processed_at is null;
alter table outbox enable row level security;
alter table outbox force row level security;
create policy tenant_isolation on outbox
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant insert on outbox to mycel_app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_worker') then
    create role mycel_worker nologin;
  end if;
end $$;
-- The migrating (operator) role switches to mycel_worker with `set local role` per drain.
grant mycel_worker to current_user;
grant usage on schema public to mycel_worker;
grant select, update on outbox to mycel_worker;
create policy worker_drain on outbox to mycel_worker using (true) with check (true);
