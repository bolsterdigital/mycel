-- 0016: stuck work made visible and recoverable (TODO #17c, brief observability-c-recovery;
-- ADR 011 rules 1 and 2). Three kinds of work can stall without anyone noticing: an exhausted job
-- (`done_at is null and attempts >= max_attempts`), an outbox event that failed MAX_ATTEMPTS (10,
-- outbox.ts) passes without reaching every subscriber, and a mail intent that is unknown or
-- abandoned (docs/reference/mail.md). Two readers get to see them, each with its own grants:
--
--   * `mycel_ops`, the hoster's platform-wide view and recovery (platform API, `npm run platform
--     -- ops`). Grants are on columns, so a payload, an event's props and its actor stay
--     unreadable whatever a query asks; it may change only a stuck row, and only into a retry
--     or a close (the update policies below say why reading is wider than that).
--   * `mycel_app`, the tenant administrator's view of its own jobs (`ops.status`, `ops.job.retry`,
--     `ops.job.close`) under `tenant_isolation`, again without the payload. Dead outbox events stay
--     the hoster's: they are rare and need platform recovery.
--
-- Rejected: `mycel_worker` for this (the fronts never hold the operator connection, ADR 011 rule
-- 1), widening `mycel_platform` (it manages tenants; reading queues is another job, rule 2), and a
-- security-definer function per question (the rights would hide in function bodies nobody
-- reviews).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mycel_ops') then
    create role mycel_ops nologin;
  end if;
end $$;
-- Entered with `set local role` like mycel_platform (0010): from the operator connection by the
-- CLI, from the mycel_authenticator login by the platform API, which never holds owner rights.
grant mycel_ops to current_user;
grant mycel_ops to mycel_authenticator with inherit false;
grant usage on schema public to mycel_ops;

-- Jobs: every column but `payload`. Reading is every row's metadata, changing is an exhausted
-- row only, and the change must be a retry (`attempts = 0`, lease released) or a close (`done_at`).
--
-- Why the select policy is `using (true)` and not "exhausted only" (the #17c review, 2026-10-22):
-- Postgres checks the new row of an UPDATE whose WHERE reads a column against the role's SELECT
-- policies as well, and a recovered row is by definition no longer stuck. A select policy narrow
-- enough to show stuck rows only would have to foresee every row a recovery produces, and misses
-- the one that matters most: a job whose worker died on every attempt has no `last_error`, so
-- "retried rows carry an error" does not hold. `jobs` is a platform queue (ADR 011 rule 1), the
-- payload stays unreadable by the column grant, and the listings (recovery.ts) select the stuck
-- rows themselves. Rejected: a request table the worker applies (asynchronous, one more table,
-- and the hoster cannot see the outcome), and a security-definer function (rights in a body).
grant select (id, tenant_id, type, key, run_at, attempts, max_attempts, claimed_at, done_at,
              last_error, created_at) on jobs to mycel_ops;
grant update (attempts, run_at, claimed_at, done_at, last_error) on jobs to mycel_ops;
create policy ops_jobs on jobs for select to mycel_ops using (true);
create policy ops_jobs_recover on jobs for update to mycel_ops
  using (done_at is null and attempts >= max_attempts)
  with check ((attempts = 0 and claimed_at is null) or done_at is not null);

-- Outbox: neither `actor` nor `props`; the same shape as jobs. A retry resets `attempts` and keeps
-- `delivered_to`, so only the subscribers that never delivered run again.
grant select (id, tenant_id, type, occurred_at, attempts, delivered_to, processed_at, last_error,
              available_at) on outbox to mycel_ops;
grant update (attempts, available_at, last_error) on outbox to mycel_ops;
create policy ops_outbox on outbox for select to mycel_ops using (true);
create policy ops_outbox_recover on outbox for update to mycel_ops
  using (processed_at is null and attempts >= 10)
  with check (attempts = 0);

-- Mail intents hold no address (`correlation` is a hash): every column, attempted and not sent.
-- No update: an intent is never closed by hand (brief decision 4); its `mail.reconcile` job is.
grant select on mail_sends to mycel_ops;
create policy ops_mail on mail_sends for select to mycel_ops
  using (sent_at is null and attempted_at is not null);

-- Names for the overview. `tenants` has no RLS (0008: mycel_app reads `tenant_directory`), so the
-- column grant alone decides; entitlements stay unreadable.
grant select (id, slug, name, status) on tenants to mycel_ops;

-- The tenant administrator (brief decision 2): its own jobs without the payload, and the two
-- recoveries; `ops.job.retry` and `ops.job.close` check exhaustion. Platform jobs (`tenant_id`
-- null) stay invisible: `tenant_isolation` never matches null. Bound to mycel_app now that it
-- reads through it (ADR 011 consequences; mycel_worker has its own policy).
grant select (id, tenant_id, type, key, run_at, attempts, max_attempts, claimed_at, done_at,
              last_error, created_at) on jobs to mycel_app;
grant update (attempts, run_at, claimed_at, done_at, last_error) on jobs to mycel_app;
alter policy tenant_isolation on jobs to mycel_app;
-- The schema owner may enter mycel_app (`set local role`) like the worker roles above: the
-- conformance suites write a fixture row as the application role, which an owner without
-- superuser (managed Postgres) could not do until now. Membership without inheritance: nothing
-- the owner lacks, nothing mycel_app gains.
grant mycel_app to current_user with set true, inherit false;

-- The ops listings: exhausted jobs and dead events by tenant, outside the due-work indexes.
create index jobs_exhausted on jobs (tenant_id, created_at)
  where done_at is null and attempts >= max_attempts;
create index outbox_dead on outbox (tenant_id, occurred_at)
  where processed_at is null and attempts >= 10;
