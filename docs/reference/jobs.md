# Jobs and the outbox

Background work runs in one worker process over two Postgres queues, both claimed across tenants as `mycel_worker` with `FOR UPDATE SKIP LOCKED`, so any number of workers can run side by side (ADR 011, [`../adr/011-background-roles-and-outbox.md`](../adr/011-background-roles-and-outbox.md); ADR 012 rule 4). The **outbox** carries committed domain events to in-process subscribers; the **jobs** table carries work planned for a time. The core says what to run and when (`packages/core/src/jobs/`); the queue is `packages/db/src/jobs.ts` and `packages/db/src/outbox.ts`; which code runs a job type, and under which role, is `packages/api/src/jobs.ts`; the loops start in `Runtime.startWorker` (`packages/api/src/compose.ts`), entered from `packages/api/src/worker.ts`. Stuck work and its recovery are in [ops.md](ops.md); the `mail.reconcile` job in [mail.md](mail.md); the worker's health and metrics in [observability.md](observability.md).

## The job record

A row of `jobs` (migration 0009), `JobRecord` in `packages/core/src/jobs/ports.ts`:

| Column         | Content                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `id`           | UUIDv7                                                                                            |
| `tenant_id`    | the tenant of a tenant job; null for a platform job                                               |
| `type`         | a key of `JobPayloads` (`packages/core/src/jobs/types.ts`), each with a strict Zod payload schema |
| `key`          | the deterministic key (below); at most one open job per key                                       |
| `run_at`       | when the job is due; a failure moves it to the retry time                                         |
| `payload`      | jsonb, validated against the type's schema before a handler sees it (`parseJobPayload`)           |
| `attempts`     | runs claimed so far; counted at the claim                                                         |
| `max_attempts` | default 10                                                                                        |
| `claimed_at`   | the lease: set by the claim, cleared by a failure                                                 |
| `done_at`      | set when the job finished (or was closed); null while open                                        |
| `last_error`   | the last failure's message, scrubbed of addresses and secrets (`scrubText`)                       |

There is no status column; the state is derived. Open: `done_at is null`. Exhausted: open and `attempts >= max_attempts`.

## Planning a job and its key

A use case plans work with `ctx.jobs.enqueue({ type, key, runAt, payload })` (the `Scheduler` port) inside its own transaction, like `ctx.events.publish`, so a job exists if and only if the change that planned it committed. `jobScheduler` (`packages/db/src/jobs.ts`) inserts as `mycel_app` under the tenant's own id and does nothing on a conflict: `enqueue` returns `false` when an open job with that key exists, and leaves it as it is.

`jobKey(type, subject)` is `<type>:<subject>` for a tenant job and `<type>:<period>` for a recurring platform job. The partial unique index `jobs_open_key` on `key where done_at is null` makes it the idempotency: the subject must be globally unique, so a subject that can move between tenants carries the tenant id (`hostnames.reverify:<tenant>:<hostname>`). Other keys: `content.publish:<item>:<locale>:<schedule>`, `tenant.export:<export>`, `mail.reconcile:<subscriber>:<event>`.

## Claim, lease and outcome

1. **Claim** (`claimJobs`, one short transaction as `mycel_worker`): up to a batch of jobs that are open, due, not exhausted, and unclaimed or with a lease older than `JOB_LEASE_SECONDS`, oldest `run_at` first; it stamps `claimed_at = now()` and counts the attempt.
2. **Run** the handler without any lock on the queue.
3. **Complete** (`completeJob`): `done_at = now()`, `last_error` cleared. When the handler returned `{ next }`, the same job (type, key, payload, tenant) is planned again at that time in the same transaction; a re-plan from inside the handler would be refused, because the running job still holds its key.
4. **Fail** (`failJob`): `last_error` scrubbed, lease released, `run_at = now() + min(2^attempts, 3600)` seconds. A type without a handler is a failure.

Complete and fail are guarded on `attempts` and `done_at is null`: if the lease expired and another worker claimed the job meanwhile, the late run changes nothing (`superseded`, logged as a warning) and the newer run owns it. A worker that dies mid-job leaves its lease to expire. A long job renews its lease with `touchJob`: `tenant.export` does so every `HEARTBEAT_MS` (`packages/db/src/tenant-exports.ts`). An exhausted job stays in the table with its `last_error` until someone recovers it ([ops.md](ops.md)).

The job loop (`startJobWorker`) ticks every `JOBS_INTERVAL_MS`: plan the recurring jobs, then claim and run one batch; while a batch came back non-empty it ticks again at once.

## Tenant jobs and platform jobs

| Kind     | `tenant_id` | Runs as                                                                                                                                                                                                |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tenant   | set         | `tenantJob`: a unit of work as `mycel_app` under RLS, with `systemPrincipal(tenant, 'jobs:<type>', access)` carrying the tenant's current entitlements and status ([entitlements.md](entitlements.md)) |
| platform | null        | `platformJob`: on the operator connection, each function entering its own role per transaction                                                                                                         |

A tenant handler throws when the job has no tenant, a platform handler when it has one. `mail.reconcile`, `connections.run`, `assist.run` and `tenant.export` are tenant jobs that open their own units of work instead of one `tenantJob` transaction. A platform job that works per tenant (`media.orphans`, `tenant.export.expire`, `assist.retention`) gets the tenant list from `mycel_platform` and visits each tenant in its own unit of work as `mycel_app`, never reading across tenants; in the first two, one tenant's failure is reported and the job fails after the others have run, so it is retried.

## Recurring platform jobs

`RECURRING_JOBS` (`packages/api/src/jobs.ts`). On every tick `ensureRecurring` inserts the next period of each, key `<type>:<label>` due at the period's start (UTC), as `mycel_worker`; a period already planned is one index conflict, so any number of workers plan it at most once, and a finished period is never planned again.

| Type                   | Cadence | Key label       | Runs as                                                                      |
| ---------------------- | ------- | --------------- | ---------------------------------------------------------------------------- |
| `events.partitions`    | monthly | `YYYY-MM`       | schema owner: monthly `events` partitions up to three months ahead (ADR 003) |
| `rate_limits.sweep`    | hourly  | `YYYY-MM-DDTHH` | `mycel_janitor`: expired rate-limit and login-attempt windows                |
| `media.orphans`        | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant: media files without a row, older than a day          |
| `jobs.retention`       | daily   | `YYYY-MM-DD`    | `mycel_worker`: finished jobs older than `JOBS_RETENTION_DAYS`               |
| `audit.retention`      | daily   | `YYYY-MM-DD`    | `mycel_audit_janitor` ([audit.md](audit.md))                                 |
| `assist.retention`     | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant: expired assistance proposals                         |
| `tenant.export.expire` | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant ([export.md](export.md))                              |

## Retention

`jobs.retention` (`deleteFinishedJobs`, `packages/db/src/ops.ts`) deletes jobs whose `done_at` is older than `JOBS_RETENTION_DAYS`, in batches until none are left. The restrictive delete policy `worker_retention` (migration 0014) lets `mycel_worker` delete finished rows only, so an open job, exhausted or not, can never disappear whatever the query asks.

## The outbox

`outboxEventBus` writes an event into `outbox` in the use case's own transaction. `drainOutbox` (`packages/db/src/outbox.ts`, as `mycel_worker`) claims a batch of due events (`processed_at is null`, `available_at <= now()`, `attempts < MAX_ATTEMPTS`) in id order and, unlike jobs, delivers them inside that claim transaction. Each subscriber that wants the type and is not yet in `delivered_to` handles the event; one that succeeds is added to `delivered_to`, so a retry runs only the others. When every subscriber delivered, `processed_at` is set; otherwise `attempts` grows, `last_error` holds the scrubbed message and `available_at` moves `min(2^attempts, 3600)` seconds ahead. After `MAX_ATTEMPTS` failed passes an event is dead: no longer drained, counted by `queueLag`, recoverable only by the hoster. The outbox loop (`startOutboxWorker`) ticks every `OUTBOX_INTERVAL_MS`, at once again while there is a backlog. `readOutboxEvent` is the outbox's second reader, for `mail.reconcile`.

## Constants

| Constant              | Value                     | Where                                  | Why                                                                      |
| --------------------- | ------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `JOB_LEASE_SECONDS`   | 300                       | `packages/db/src/jobs.ts`              | a claim older than this is free again; its worker is presumed dead       |
| `max_attempts`        | 10                        | `packages/db/migrations/0009_jobs.sql` | column default; an exhausted job waits for recovery                      |
| job backoff           | `min(2^attempts, 3600)` s | `packages/db/src/jobs.ts`              | 2, 4, 8 ... seconds after each failure, at most an hour                  |
| job batch size        | 10                        | `packages/db/src/jobs.ts`              | jobs per claim (`claimJobs`)                                             |
| `JOBS_INTERVAL_MS`    | 5 s                       | `packages/api/src/compose.ts`          | job loop tick when the queue is empty                                    |
| `HEARTBEAT_MS`        | 60 s                      | `packages/db/src/tenant-exports.ts`    | how often a running export renews its lease, well inside the 300 s lease |
| `MAX_ATTEMPTS`        | 10                        | `packages/db/src/outbox.ts`            | failed passes before an outbox event is dead                             |
| outbox backoff        | `min(2^attempts, 3600)` s | `packages/db/src/outbox.ts`            | the same schedule as jobs                                                |
| outbox batch size     | 50                        | `packages/db/src/outbox.ts`            | events per claim (`drainOutbox`)                                         |
| `OUTBOX_INTERVAL_MS`  | 1 s                       | `packages/api/src/compose.ts`          | outbox loop tick when nothing is pending                                 |
| `JOBS_RETENTION_DAYS` | 30 (1 to 3650)            | `packages/api/src/compose.ts`          | env; finished jobs older than this are deleted daily                     |
| retention batch       | 1000                      | `packages/db/src/ops.ts`               | rows per delete, so no transaction holds many row locks                  |
