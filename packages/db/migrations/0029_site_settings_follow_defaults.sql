-- TODO #53: a row made by the first write of one setting no longer snapshots the defaults of
-- the others. Null means "follow the current default", so a later default reaches every tenant
-- that never chose its own value. Existing rows keep what they hold. Rejected: clearing stored
-- values at version 0, which would change sites that render today without anyone asking.
alter table site_settings
  alter column theme drop not null,
  alter column chrome drop not null;
