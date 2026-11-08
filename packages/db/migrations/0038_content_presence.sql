-- Who has an item open right now (ADR 029): one row per actor, item and browser tab, overwritten
-- on every beat and read only within a short window.
--
-- Unlogged on purpose: a report every twenty seconds per open tab does not belong in the WAL or on
-- a replica, and after a crash the table is empty, which is correct (nobody is known to be
-- anywhere). `mycel_app` may not delete; expired rows go through `mycel_janitor` in the hourly
-- `rate_limits.sweep`, so a dormant tenant does not keep a trace of who last looked at what.
-- The actor is part of the key, so a session id cannot be used to overwrite someone else's row.
--
-- Rejected: an in-memory map per process (the web app, API and MCP are separate processes), and
-- deleting expired rows from the beat itself (a tenant that goes quiet keeps its last rows).
create unlogged table content_presence (
  tenant_id uuid not null references tenants(id),
  item_id uuid not null,
  actor_kind text not null,
  actor_id text not null,
  session_id uuid not null,
  actor jsonb not null,
  state text not null check (state in ('viewing', 'editing')),
  last_seen_at timestamptz not null,
  primary key (tenant_id, item_id, actor_kind, actor_id, session_id),
  foreign key (tenant_id, item_id) references content_items(tenant_id, id) on delete cascade
);
alter table content_presence enable row level security;
alter table content_presence force row level security;
create policy tenant_isolation on content_presence to mycel_app
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update on content_presence to mycel_app;

grant select, delete on content_presence to mycel_janitor;
create policy janitor_sweep on content_presence for delete to mycel_janitor using (true);
create policy janitor_read on content_presence for select to mycel_janitor using (true);
