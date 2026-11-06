-- "Ter publicatie aanbieden" (decided 2026-11-06): a locale offered for publication by
-- someone who may write. A mark beside the publication pointers of `content_item_locales`, not a
-- status: the generated `status` column (0011) stays as it is, and core's lifecycle clears the
-- mark when the locale is published or scheduled.
--
-- * `review_since`: the moment of the first offer; offering again or saving keeps it, so the
--   attention list does not make one draft news twice.
-- * `review_note`: the writer's optional note to whoever publishes, at most 1000 characters
--   (`REVIEW_NOTE_MAX` in core).
--
-- Who offered it is not stored here: the audit log already holds the actor of every
-- `content.review.request`, and an operator id would not survive an export to another
-- installation (memberships travel by address, 0034). The columns are site data and travel with
-- the export as the rest of the row does; an older archive imports them as null.
--
-- Rejected: a separate `content_reviews` table (a second key to keep in step with the locale row
-- it marks, and a row to delete on every publish) and a fifth `status` value (ADR 012 would need
-- superseding for what is a request to a person, not a state of the text).
alter table content_item_locales
  add column review_since timestamptz,
  add column review_note text check (char_length(review_note) <= 1000),
  add constraint content_item_locales_review_note
    check (review_note is null or review_since is not null);

-- The attention list reads every offer of a site, newest first; few rows carry one.
create index content_item_locales_review
  on content_item_locales (tenant_id, review_since desc)
  where review_since is not null;
