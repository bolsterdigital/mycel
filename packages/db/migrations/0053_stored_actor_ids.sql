-- 0053: a stored actor carries kind and id, never an address (ADR 035 rule 4, #224). Until now
-- every write that recorded who acted stored the whole `Actor`, whose operator variant held the
-- operator's e-mail address, so the address sat in revisions, bulk plans and their effects, API
-- keys, media and both erasure registers, against what 0019, 0050 and ADR 034 rule 2 say those
-- registers hold. From this release on every adapter writes `storedActor` (core principal.ts);
-- this migration removes the `email` key from what is already at rest, once.
--
-- It is the one in-place change to revisions and plans ADR 035 allows: only the `email` key of an
-- operator actor goes, no other key and no other row changes, and it runs as the schema owner,
-- not as any role a front can enter (mycel_app still has no update on revisions or plans). Each
-- table is unforced for the update and forced again after it, as 0013 and 0020 did: the owner is
-- bound by forced RLS without a tenant context and would otherwise update nothing (0018).
--
-- The short-lived copies (outbox, presence) are cleaned as well, although they would expire on
-- their own term: then "no stored actor carries an address" holds the moment this commits, and
-- storage.conformance.test.ts can say so without exceptions. Form feed settings and connection
-- intents store `{ kind, id }` and never held an address; their update matches no row and is
-- kept so the list is the complete list of actor columns.
--
-- Lock time: `alter table ... force row level security` takes an access exclusive lock that
-- lasts until the migration commits, so every listed table is closed for reads and writes for the
-- whole run. One filtered update per table touches only operator actors that still carry an
-- address. Batching inside this file would not shorten that lock (the runner applies a file in
-- one transaction, `migrate.ts`), and a batch job after the migration would leave addresses at
-- rest after the release, which rule 4 rules out. The lock time measured on 100,000 operator
-- revisions is in the pull request of #224. An image of an earlier release, run on this schema
-- after a rollback (docs/upgrading.md promise 4), writes the address again on what it saves;
-- this file does not run twice, so such rows keep it until a later migration removes them.
-- Rejected: a column grant to mycel_app or a security-definer function for the rewrite (a path to
-- rewrite history that outlives the one step that needs it) and a new revision per item (the old
-- revisions would keep the address).

alter table content_revisions no force row level security;
update content_revisions set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table content_revisions force row level security;

alter table content_bulk_plans no force row level security;
update content_bulk_plans set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table content_bulk_plans force row level security;

alter table content_bulk_effects no force row level security;
update content_bulk_effects set result = jsonb_set(result, '{actor}', (result->'actor') - 'email')
  where result->'actor'->>'kind' = 'operator' and result->'actor' ? 'email';
alter table content_bulk_effects force row level security;

alter table form_feed_settings no force row level security;
update form_feed_settings set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table form_feed_settings force row level security;

alter table connection_intents no force row level security;
update connection_intents set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table connection_intents force row level security;

alter table media no force row level security;
update media set created_by = created_by - 'email'
  where created_by->>'kind' = 'operator' and created_by ? 'email';
alter table media force row level security;

alter table api_keys no force row level security;
update api_keys set created_by = created_by - 'email'
  where created_by->>'kind' = 'operator' and created_by ? 'email';
alter table api_keys force row level security;

alter table erasures no force row level security;
update erasures set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table erasures force row level security;

alter table person_erasures no force row level security;
update person_erasures set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table person_erasures force row level security;

alter table outbox no force row level security;
update outbox set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table outbox force row level security;

alter table content_presence no force row level security;
update content_presence set actor = actor - 'email'
  where actor->>'kind' = 'operator' and actor ? 'email';
alter table content_presence force row level security;
