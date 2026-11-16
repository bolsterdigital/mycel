-- A page's type profile (ADR 022 rule 3): an event is a page with the profile 'event', its
-- metadata in the revision's document. The item carries the profile, fixed at creation like its
-- type, so a site's events list without reading revisions. Null on every other item. Rejected: an
-- events table with its own read route, which would duplicate what a page has.
alter table content_items add column profile text
  check (profile in ('event'))
  check (profile is null or type = 'page');
