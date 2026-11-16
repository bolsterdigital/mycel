-- An image's licence is a closed list with an optional name for `other` ({ code, text? }, core
-- `MediaLicence`), so a site links it and a reuser can read it. A stored free text keeps its
-- words as `other` with that text, so nothing is lost and no guess is made; an empty one becomes
-- no licence. Rejected: dropping the old values (a migration that loses data), parsing "CC-BY"
-- or "cc by-sa" into a code (guesswork), and a second text column beside a code.
alter table media drop constraint media_licence_check;
alter table media
  alter column licence type jsonb
  using case
    when nullif(btrim(licence), '') is null then null
    else jsonb_build_object('code', 'other', 'text', btrim(licence))
  end;
alter table media add constraint media_licence_check
  check (licence is null or jsonb_typeof(licence) = 'object');
