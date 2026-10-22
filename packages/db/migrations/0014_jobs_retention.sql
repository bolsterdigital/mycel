-- Retention of finished jobs (TODO #17a, brief observability-a decision 10). The worker deletes
-- jobs that finished more than JOBS_RETENTION_DAYS ago (`deleteFinishedJobs`, recurring job
-- `jobs.retention`). `jobs` is mycel_worker's queue (ADR 011 rule 2), so the delete is its own.
--
-- The policy is restrictive: `worker_jobs` (0009) is a permissive `for all ... using (true)`, and a
-- second permissive policy would be OR-ed with it and allow every row. Restrictive is AND-ed, so a
-- delete reaches finished rows only. An open job, exhausted or not (and so the open key of a
-- `hostnames.reverify`), can never disappear, whatever the query asks. Rejected: dropping and
-- splitting `worker_jobs` per command, which touches the claim path for no gain.

grant delete on jobs to mycel_worker;
create policy worker_retention on jobs as restrictive for delete to mycel_worker
  using (done_at is not null);

-- The retention scan: finished rows by age, outside the open-row indexes of 0009.
create index jobs_finished on jobs (done_at) where done_at is not null;
