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
--   * Writes happen on the operator connection only: the platform API and `npm run platform`
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
