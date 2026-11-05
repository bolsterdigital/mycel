-- #185 step 6: the media register takes an MP3, for the `audio` block. Only widens the two checks,
-- so every existing row still fits and nothing is rewritten. Rejected: dropping the checks and
-- leaving the list to core alone, which would let a row in that the backup's expected-file list
-- (docker/backup/media-expected.sql) cannot name.
alter table media drop constraint media_kind_check;
alter table media add constraint media_kind_check
  check (kind in ('image', 'document', 'audio'));

alter table media drop constraint media_content_type_check;
alter table media add constraint media_content_type_check
  check (content_type in
    ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
     'application/pdf', 'audio/mpeg'));
