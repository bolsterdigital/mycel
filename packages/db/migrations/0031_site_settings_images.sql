-- #86: a site's images, today the default image an item's featured and share image fall back to
-- (core `content/effective.ts`). A versioned document like `general` (0030): null means the
-- default (no image), so every existing site keeps rendering what it renders now, and the next
-- site image needs no new column. The image itself is protected by a `media_usages` row under the
-- ref `site:images`, written in the same transaction as the document, not by a foreign key: the
-- export loads `site_settings` before `media`, and `media.delete` already refuses on a usage.
-- Rejected: a `default_image_id` column, one column per future site image.
alter table site_settings
  add column images jsonb,
  add column images_version integer not null default 0 check (images_version >= 0);
