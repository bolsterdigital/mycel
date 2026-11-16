-- 0066: a suggestion may be a headline proposal (#24 B2). The task check gains one value; no row
-- changes and no new column: a headline reads the article's own lead at the pinned base revision,
-- so the row needs no source ids or copy of the text. Rejected: a lead fingerprint column, which
-- would duplicate what the immutable base revision already proves.
alter table assist_suggestions
  drop constraint assist_suggestions_task_check,
  add constraint assist_suggestions_task_check
    check (task in ('alt', 'translate', 'lead', 'headline'));
