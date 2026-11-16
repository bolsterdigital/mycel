-- 0067: a suggestion may be a section proposal (#24 B3). The task check gains one value; no row
-- changes and no new column. The lead is pinned by the base revision; the offered sections are
-- not, so `block_id` holds an opaque hash of their ids and titles that the worker and acceptance
-- compare for equality, never parse. Rejected: a fingerprint column used by one task only, and
-- copying the section titles into the row, which would keep tenant text past its source.
alter table assist_suggestions
  drop constraint assist_suggestions_task_check,
  add constraint assist_suggestions_task_check
    check (task in ('alt', 'translate', 'lead', 'headline', 'section'));
