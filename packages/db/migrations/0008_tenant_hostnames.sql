-- 0008: hostnames of a tenant and the tenant directory view (TODO #14; ADR 014, ADR 011 rule 1,
-- ADR 017).
--
-- `tenant_hostnames` is tenant data under forced RLS like every other table: a tenant's admin
-- adds, verifies and removes its custom domains through `tenant.hostnames.*` as mycel_app; the
-- platform hostname `<slug>.<platform domain>` is written by the platform path that creates the
-- tenant (`upsertTenant`, operator connection). The hostname is the primary key, so a name is
-- globally unique: an insert that collides is a typed `conflict` that never says whose it is.
--
-- Resolving a hostname happens before a tenant context exists, because the hostname is what
-- establishes that context (ADR 002 rule 3). That read goes through `mycel_auth`, exactly like
-- an API key or a membership (0007): `createSiteDirectory` in packages/db/src/hostnames.ts.
-- Rejected: a SECURITY DEFINER view or function owned by the schema owner (forced RLS binds the
-- owner too, so it would still see nothing without a role), and a second pre-context role
-- `mycel_directory` with the same rights profile as mycel_auth.
--
-- `tenant_directory`: mycel_app loses its direct `select` on `tenants` and reads this view
-- instead, so TODO #16 can put entitlements on `tenants` without every app transaction seeing
-- every tenant's plan. The owner's view runs with the owner's rights; `tenants` has no RLS.

create table tenant_hostnames (
  -- Normalised in core (tenants/model.ts): lowercase punycode, no trailing dot, no port.
  hostname            text primary key
                      check (hostname = lower(hostname) and hostname ~ '^[a-z0-9.-]{1,253}$'),
  tenant_id           uuid not null references tenants(id),
  kind                text not null check (kind in ('platform', 'custom')),
  is_primary          boolean not null default false,
  -- Proof of control: the TXT record `_mycel-verify.<hostname>` must carry this value.
  verification_token  text,
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  check (kind = 'platform' or verification_token is not null)
);
-- Exactly one primary per tenant (ADR 017: one site, one address).
create unique index tenant_hostnames_primary on tenant_hostnames (tenant_id) where is_primary;
create index tenant_hostnames_tenant on tenant_hostnames (tenant_id);

alter table tenant_hostnames enable row level security;
alter table tenant_hostnames force row level security;
create policy tenant_isolation on tenant_hostnames
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
grant select, insert, update, delete on tenant_hostnames to mycel_app;

-- Pre-context resolution (ADR 011 rule 1): which site is this request for.
grant select on tenant_hostnames to mycel_auth;
create policy auth_lookup on tenant_hostnames for select to mycel_auth using (true);

-- The directory mycel_app reads instead of the table (0001 granted the table; TODO #16 adds
-- columns to `tenants` that must not be visible to every app transaction).
create view tenant_directory as
  select id, slug, name, default_locale, locales from tenants;
revoke select on tenants from mycel_app;
grant select on tenant_directory to mycel_app;
