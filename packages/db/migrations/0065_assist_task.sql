-- 0065: a suggestion names its task and, for a lead, the prose blocks it was asked from,
-- so the worker and acceptance pick the right contract without parsing `block_id`. Existing rows
-- keep their meaning: an encoded `translate:` descriptor is a translation, every other row an alt
-- text. The source ids are block ids only, never text; the output stays operational data under
-- the existing retention. Rejected: encoding the lead's blocks into `block_id` as translation
-- does (a second string format to parse) and a task table (one fixed set of three tasks).
alter table assist_suggestions
  add column task text not null default 'alt' check (task in ('alt', 'translate', 'lead')),
  add column source_block_ids text[] not null default '{}';
update assist_suggestions set task = 'translate' where block_id like 'translate:%';
alter table assist_suggestions alter column task drop default;
