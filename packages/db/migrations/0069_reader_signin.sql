-- Reader sign-in (ADR 016 rule 1, ADR 019 rules 5 to 8): the pending magic links and the reader
-- sessions of a tenant. Both are tenant tables behind forced RLS and both are this
-- installation's work in progress, not the tenant's data: an export leaves them out, so a link
-- or a session never survives a move to another installation.
--
-- A link row is the one copy of the address this flow keeps, with a hash of the signed token
-- (never the token). `mycel_app` may set `consumed_at` and nothing else, and the use happens in
-- one conditional update, so of two requests with the same link one finds the row. A session row
-- names the supporter by id; the cookie names the session. `mycel_app` may set `revoked_at`
-- only: a session is ended, never moved to another supporter or stretched.
--
-- Neither table gives `mycel_app` a delete. Erasure deletes the links of an erased address and
-- the sessions of an erased supporter as `mycel_erasure`, on the current tenant only (0019); the
-- hourly sweep deletes what expired more than an hour ago as `mycel_janitor`, whose policies
-- reach no younger row, so a sweep can never end a live link or session whatever its query asks
-- (0018).
--
-- Rejected: a stateless session cookie like the operator's (0007: nothing to end before its
-- clock runs out, which an erasure needs), the raw token in the row (a database read would be a
-- sign-in), and one table for both (a link is an address waiting, a session is a supporter
-- reading; they are erased by different keys).
create table reader_signin_links (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id),
  email        text not null check (email = lower(btrim(email)) and strpos(email, '@') > 1),
  token_hash   text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  locale       text not null check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  return_path  text check (return_path is null or (return_path like '/%' and return_path not like '//%')),
  created_at   timestamptz not null,
  expires_at   timestamptz not null check (expires_at > created_at),
  consumed_at  timestamptz
);
create index reader_signin_links_email on reader_signin_links (tenant_id, email);
alter table reader_signin_links enable row level security;
alter table reader_signin_links force row level security;
create policy tenant_isolation on reader_signin_links to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (consumed_at) on reader_signin_links to mycel_app;

grant select (id, tenant_id, email), delete on reader_signin_links to mycel_erasure;
create policy erasure_apply on reader_signin_links to mycel_erasure
  using (tenant_id = current_tenant_id());

grant select, delete on reader_signin_links to mycel_janitor;
create policy janitor_read on reader_signin_links for select to mycel_janitor
  using (expires_at < now() - interval '1 hour');
create policy janitor_sweep on reader_signin_links for delete to mycel_janitor
  using (expires_at < now() - interval '1 hour');

create table reader_sessions (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  supporter_id  uuid not null,
  created_at    timestamptz not null,
  expires_at    timestamptz not null check (expires_at > created_at),
  revoked_at    timestamptz,
  foreign key (tenant_id, supporter_id) references supporters (tenant_id, id)
);
create index reader_sessions_supporter on reader_sessions (tenant_id, supporter_id);
alter table reader_sessions enable row level security;
alter table reader_sessions force row level security;
create policy tenant_isolation on reader_sessions to mycel_app
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
grant select, insert, update (revoked_at) on reader_sessions to mycel_app;

grant select (id, tenant_id, supporter_id), delete on reader_sessions to mycel_erasure;
create policy erasure_apply on reader_sessions to mycel_erasure
  using (tenant_id = current_tenant_id());

grant select, delete on reader_sessions to mycel_janitor;
create policy janitor_read on reader_sessions for select to mycel_janitor
  using (expires_at < now() - interval '1 hour');
create policy janitor_sweep on reader_sessions for delete to mycel_janitor
  using (expires_at < now() - interval '1 hour');
