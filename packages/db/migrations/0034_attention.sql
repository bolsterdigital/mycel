-- The attention list (decided 2026-11-06): what asks for attention is derived from the rows that
-- already hold the truth, so this migration adds two moments and an index.
--
-- * `jobs.failed_at`: when a run last failed. An exhausted job is news from that moment, not from
--   its creation and not from `run_at` (which the backoff can put hours ahead). Set by the worker
--   in `failJob`; a retry leaves it, the next failure moves it. Old rows stay null and fall back
--   to `created_at`.
-- * `tenant_memberships.attention_seen_at`: until when this member has read the notifications.
--   One moment per member, not a row per notification: a derived notification has no row to mark,
--   and a solved one disappears by itself. Not exported (export.ts strips it): a member's
--   reading habit is not site data.
--
-- Rejected: a `notifications` table with a row per member per event (fan-out on every event, a
-- second truth beside the status page, rows to clean up once the problem is gone), and a separate
-- read-state table (a second key to keep in step with the membership it belongs to).
alter table jobs add column failed_at timestamptz;
-- The tenant administrator reads it beside the other columns of 0016; mycel_ops for the platform
-- view. mycel_worker already updates every column of `jobs` (0009).
grant select (failed_at) on jobs to mycel_app, mycel_ops;

alter table tenant_memberships add column attention_seen_at timestamptz;

-- The attention list reads the newest intents of every connection in one statement
-- (`ConnectionIntents.recent`); per connection that is a short index walk, also for
-- `connection.intent.list`, which until now sorted a connection's whole log.
create index connection_intents_recent
  on connection_intents (tenant_id, connection_id, created_at desc);
