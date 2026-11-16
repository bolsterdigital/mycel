-- The type profile 'zone' (brief prefooter): a page shown inside other pages, between the
-- content and the footer, placed from the navigation document (ADR 036 rule 4 as amended). Only
-- the check grows; no data changes (clean cuts, owner decision 2026-11-15). Rejected: a zones
-- table with its own editor, which would duplicate the page's revisions and publication.
alter table content_items drop constraint content_items_profile_check;
alter table content_items add constraint content_items_profile_check
  check (profile in ('event', 'zone'));
