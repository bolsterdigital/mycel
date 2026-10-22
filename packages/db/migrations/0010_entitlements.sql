-- 0010: entitlements and status on the tenant (TODO #16; ADR 015, ADR 011 rule 1, ADR 002 rule 4).
--
-- `entitlements` is the hoster's document (ADR 015 rule 2): what this tenant may use. It is stored
-- as written; the effective values are that document merged over the defaults in core
-- (`effectiveEntitlements`), so `{}` means "everything, with generous limits" and a self-hoster
-- never has to touch it. `status` is not an entitlement: `suspended` keeps the site readable and
-- export working and refuses every other command (ADR 015 rule 7).
--
-- Who sees what:
--   * mycel_app sees neither column. It lost its select on `tenants` in 0008 and reads the
--     five-column `tenant_directory` view, which stays five columns: no app transaction sees any
--     tenant's entitlements, its own included. A use case reads them from its Principal.
--   * mycel_auth reads them before a tenant context exists, with the API key, the membership or
--     the hostname that establishes it (ADR 011 rule 1). 0007 gave it the whole table; this
--     narrows it to the columns those lookups use, so nothing added to `tenants` later becomes
--     readable by default.
--   * Writes happen as mycel_platform only (below): the platform API and `npm run platform`
--     (packages/db/src/platform.ts, ADR 002 rule 4).
-- Rejected: entitlements in the session cookie (twelve hours stale) and reading them as mycel_app
-- per transaction (every app transaction could then read every tenant's plan).

alter table tenants
  add column entitlements jsonb not null default '{}'
    check (jsonb_typeof(entitlements) = 'object'),
  add column status text not null default 'active'
    check (status in ('active', 'suspended'));

revoke select on tenants from mycel_auth;
grant select (id, slug, name, default_locale, locales, entitlements, status)
  on tenants to mycel_auth;

-- The platform role (ADR 011 rule 1, ADR 002 rule 4; review round 1 of TODO #16): platform
-- operations (create a tenant, set its entitlements and status) run as `mycel_platform`, nologin,
-- entered with `set local role` like mycel_auth. The API enters it from the same
-- mycel_authenticator login, so the platform API never holds the schema owner's credentials; the
-- CLI and the seed enter it from the operator connection, so both callers have exactly these
-- grants. It reads and inserts tenants, updates only their entitlements and status, and reads
-- and inserts platform hostnames (a custom hostname is the tenant's own, through
-- `tenant.hostnames.add`); nothing else, no delete. Rejected: the operator connection in the API
-- process (ADR 011 rule 1 forbids owner credentials in web and API) and a separate platform
-- process (one more deployable for five routes).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_platform') then
    create role mycel_platform nologin;
  end if;
end $$;
grant mycel_platform to current_user;
grant mycel_platform to mycel_authenticator with inherit false;
grant usage on schema public to mycel_platform;
grant select, insert on tenants to mycel_platform;
grant update (entitlements, status) on tenants to mycel_platform;
grant select, insert on tenant_hostnames to mycel_platform;
create policy platform_hostnames on tenant_hostnames to mycel_platform
  using (true) with check (kind = 'platform');

-- Supporter admissions (ADR 015 rule 3 with ADR 019 rule 3; review round 1 of TODO #16, audit
-- point 3). The supporter projection only grows after the outbox ingest, so counting it in
-- `forms.submit` lets any number of new addresses past a cap while the worker has not run.
-- `forms.submit` therefore reserves a seat here, in its own transaction and under a per-tenant
-- advisory lock, and the ingest that writes the projection releases it in the same transaction:
-- an address is a reservation or a projection, never both. A reservation older than seven days
-- no longer counts and is swept by the tenant's next reservation (a signup whose event never
-- arrived does not hold a seat forever). Tenant data under forced RLS like every other table.
-- Rejected: counting `form_submissions` (every retry of one address would count) and writing
-- the projection from forms (ADR 003 rule 3: only the projector writes it).
create table supporter_admissions (
  tenant_id    uuid not null references tenants(id),
  -- sha256 hex of `<tenant id>:<normalised address>`, like the rate-limit key: no second copy of
  -- the address (ADR 019 rule 7), and release plus the window are its whole lifetime.
  email_hash   text not null,
  admitted_at  timestamptz not null default now(),
  primary key (tenant_id, email_hash)
);
alter table supporter_admissions enable row level security;
alter table supporter_admissions force row level security;
create policy tenant_isolation on supporter_admissions
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, delete on supporter_admissions to mycel_app;
