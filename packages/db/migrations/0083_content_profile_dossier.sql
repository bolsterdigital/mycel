-- The type profile 'dossier' (MY-260, brief dossiers): a theme page that bundles related pages and
-- articles, which name it in their document (`dossiers`). Only the check grows; no data changes.
-- Rejected: a dossiers table with a membership table beside it, which would duplicate the page's
-- revisions and publication and need a cascade when a dossier goes to the trash.
alter table content_items drop constraint content_items_profile_check;
alter table content_items add constraint content_items_profile_check
  check (profile in ('event', 'zone', 'dossier'));
