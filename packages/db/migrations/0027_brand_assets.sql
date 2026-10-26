-- #11 F. Small active assets live in the tenant settings snapshot. Replacements use MVCC,
-- so an export or backup already reading the old row retains its bytes until it completes.
alter table site_settings
  add column logo_bytes bytea,
  add column logo_width integer check (logo_width > 0),
  add column logo_height integer check (logo_height > 0),
  add column logo_version integer not null default 0 check (logo_version >= 0),
  add column font_bytes bytea,
  add column font_licence text check (length(font_licence) between 1 and 500),
  add column font_version integer not null default 0 check (font_version >= 0),
  add constraint logo_complete check ((logo_bytes is null and logo_width is null and logo_height is null) or (logo_bytes is not null and logo_width is not null and logo_height is not null)),
  add constraint font_complete check ((font_bytes is null and font_licence is null) or (font_bytes is not null and font_licence is not null));
