-- 0001: tenants, the application role, and the RLS pattern every tenant-owned table follows
-- (ADR 002). Migrations are plain, forward-only SQL: RLS and partitioning need real SQL, and an
-- agent can read the schema without learning a DSL. Run with `npm run migrate -w @mycel/db`.

create extension if not exists pgcrypto;

create table tenants (
  id          uuid primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  default_locale text not null default 'nl',
  locales     text[] not null default array['nl'],
  created_at  timestamptz not null default now()
);

-- The application connects as `mycel_app`, which is NOT the owner of any table and therefore
-- cannot bypass RLS. Migrations run as the owner. Password is set by the operator.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_app') then
    create role mycel_app nologin;
  end if;
end $$;

grant usage on schema public to mycel_app;
grant select on tenants to mycel_app;

-- Helper every policy uses. `true` as the second argument makes a missing setting return NULL
-- rather than raise, so a connection that forgot set_config() sees zero rows, not an error
-- that could be caught and ignored.
create or replace function current_tenant_id() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;

-- Pattern for every tenant-owned table (copy for each new table; a test asserts compliance):
--
--   alter table <t> enable row level security;
--   alter table <t> force row level security;
--   create policy tenant_isolation on <t>
--     using (tenant_id = current_tenant_id())
--     with check (tenant_id = current_tenant_id());
--   grant select, insert, update, delete on <t> to mycel_app;
