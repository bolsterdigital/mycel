-- 0080 (docs/reference/analytics.md): a site's measurement setting, the Plausible site its counts go to.
-- A versioned value on the site's settings row like `retention` (0048): the row is tenant-owned
-- under forced RLS (0026), exported and imported with the site, and deleted with the tenant, so
-- the identifier never reaches another tenant's read. Null reads as "off", so every existing
-- tenant stays unmeasured without a backfill. `mycel_app` already selects and updates the row;
-- no other role reads it.
--
-- The value is checked in core (`PlausibleDomain`): a bare hostname-like identifier, never a URL
-- or a script. Rejected: a table of its own (one value per tenant, and the delivery history the
-- adapter will keep is outbox state, not settings), and a key in `general` (written with
-- `content:write`; this is `tenant:admin`'s).
alter table site_settings
  add column analytics jsonb,
  add column analytics_version integer not null default 0 check (analytics_version >= 0);
