-- 0081 (docs/reference/integrations.md, ADR 022 rules 5-7): which managed integrations a site
-- switched on (YouTube, Vimeo, Google Tag Manager) with their parameters. A versioned value on the
-- site's settings row like `analytics` (0080): the row is tenant-owned under forced RLS (0026),
-- exported and imported with the site and deleted with the tenant, so one site's container id
-- never reaches another tenant's read. Null reads as "everything off", so every existing tenant
-- places nothing without a backfill. `mycel_app` already selects and updates the row.
--
-- The value is checked in core (`IntegrationSettings`): catalogue entries and validated
-- parameters, never an origin, URL or script. Rejected: a table with a row per integration (the
-- setting is read whole on every public page and written whole by one form).
alter table site_settings
  add column integrations jsonb,
  add column integrations_version integer not null default 0 check (integrations_version >= 0);
