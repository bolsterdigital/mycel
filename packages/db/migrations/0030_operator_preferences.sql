-- #88: an operator's own preferences for the admin and a site's general settings.
--
-- `operators` gets the language of the admin, a time zone and a date display. Null for the first
-- two means "follow the browser" and "follow the site". The table keeps its grants: mycel_auth
-- reads and writes every column already (0007, ADR 011 rule 1), and mycel_app's column grant
-- does not reach the new ones, so a tenant transaction never sees a member's preferences and a
-- tenant export never carries them. Checks mirror core's schema, so a value core would refuse
-- cannot be stored by any other route either.
--
-- `site_settings` gets `general`, a versioned document like theme and chrome (0029): null means
-- the current default (Europe/Amsterdam), so every existing site keeps the zone it had as a
-- constant in the admin. Rejected: a `time_zone` column with a default, which would freeze
-- today's default into every row and add a column per future general setting.
alter table operators
  add column ui_locale text check (ui_locale in ('nl', 'en')),
  add column time_zone text check (char_length(time_zone) between 1 and 64),
  add column date_format text not null default 'relative'
    check (date_format in ('relative', 'absolute'));

alter table site_settings
  add column general jsonb,
  add column general_version integer not null default 0 check (general_version >= 0);
