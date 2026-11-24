# Jobs and the outbox

Background work runs in one worker process over two Postgres queues, both claimed across tenants as `mycel_worker` with `FOR UPDATE SKIP LOCKED`, so any number of workers can run side by side (ADR 011, [`../adr/011-background-roles-and-outbox.md`](../adr/011-background-roles-and-outbox.md); ADR 012 rule 4). The **outbox** carries committed domain events to in-process subscribers; the **jobs** table carries work planned for a time. The core says what to run and when (`packages/core/src/jobs/`); the queue is `packages/db/src/operations/jobs.ts` and `packages/db/src/operations/outbox.ts`; which code runs a job type, and under which role, is `packages/api/src/jobs.ts`; the loops start in `Runtime.startWorker` (`packages/api/src/runtime/compose.ts`), entered from `packages/api/src/runtime/worker.ts`. Stuck work and its recovery are in [ops.md](ops.md); the `mail.reconcile` job in [mail.md](mail.md); the worker's health and metrics in [observability.md](observability.md).

## In short

**Background work** runs in one worker process (`Runtime.startWorker`, `packages/api/src/runtime/worker.ts`) over two Postgres queues, both claimed across tenants as `mycel_worker` with `FOR UPDATE SKIP LOCKED` so several workers can run (ADR 011). The **outbox** carries committed domain events to subscribers. The **jobs** table (migration 0009, `packages/db/src/operations/jobs.ts`) carries work planned for a time: a use case plans one with `ctx.jobs.enqueue` inside its own transaction (the core's `Scheduler` port; `mycel_app` may insert under its own tenant and nothing more), with a deterministic key (`hostnames.reverify:<tenant>:<hostname>`, `content.publish:<item>:<locale>:<schedule>`, `rate_limits.sweep:<hour>`) of which only one can be open. A claim is a five-minute lease: one short transaction stamps `claimed_at` and counts the attempt, the handler runs without a lock on the queue, and a second short transaction marks the job done (and plans its next run when the handler asks) or retries it with the outbox's backoff; a worker that dies leaves the lease to expire, and a job that exhausts its attempts stays in the table with `last_error`. Handlers are registered by type in `packages/api/src/jobs.ts`: a tenant job runs in a unit of work under a `system` principal as `mycel_app` (ADR 011 rule 3), a platform job (`tenant_id` null) on the operator connection under its own role, such as `mycel_janitor` for the hourly rate-limit sweep. Recurring platform jobs (`events.partitions` monthly, `rate_limits.sweep` hourly, `media.orphans`, `jobs.retention`, `audit.retention`, `assist.retention`, `tenant.export.expire` and `erasures.apply` daily, `donations.reconcile` and `subscriptions.charge` hourly; `RECURRING_JOBS` in `packages/api/src/jobs.ts`) are planned by the worker itself, one row per period. Job types and their payload schemas live in `core/jobs/types.ts`.

## External effects get an intent row first

**External effects get an intent row first** (ADR 019 rule 6). A subscriber that calls a provider claims a `mail_sends` row (key `<subscriber>:<event id>`) in one conditional upsert and, in the same committed transaction, plans the job `mail.reconcile` on the jobs table; then it calls the provider outside any transaction and records `sent_at` and the provider id. A provider without idempotency keys can only list what it accepted (`Mailer.lookup`), so reconciliation counts the listed ids against sibling intents with the same correlation hash and resends only when the count proves the attempt never arrived; anything ambiguous stays `unknown` until the job gives it up as `abandoned`. `packages/core/src/mailing/send-attempts.ts` is the one implementation (`sendOnce`, `settleIntent`, `reconcileMail`); the contract, the states and the residual risk are in `docs/reference/mail.md`.

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

A use case plans work with `ctx.jobs.enqueue({ type, key, runAt, payload })` (the `Scheduler` port) inside its own transaction, like `ctx.events.publish`, so a job exists if and only if the change that planned it committed. `jobScheduler` (`packages/db/src/operations/jobs.ts`) inserts as `mycel_app` under the tenant's own id and does nothing on a conflict: `enqueue` returns `false` when an open job with that key exists, and leaves it as it is.

`jobKey(type, subject)` is `<type>:<subject>` for a tenant job and `<type>:<period>` for a recurring platform job. The partial unique index `jobs_open_key` on `key where done_at is null` makes it the idempotency: the subject must be globally unique, so a subject that can move between tenants carries the tenant id (`hostnames.reverify:<tenant>:<hostname>`). Other keys: `content.publish:<item>:<locale>:<schedule>`, `content.share-card:<item>:<locale>:<revision>`, `content.share-cards:<tenant>:<theme>:<images>:<logo>` (content-model.md § Share images), `tenant.export:<export>`, `mail.reconcile:<subscriber>:<event>` (for a newsletter `mail.reconcile:mailing.edition:<supporter>:<edition>`), `mailing.edition.deliver:<edition>`, `mailing.automation.step:<series>:<supporter>:<position>` ([mail.md](mail.md#welcome-series)).

## Claim, lease and outcome

1. **Claim** (`claimJobs`, one short transaction as `mycel_worker`): up to a batch of jobs that are open, due, not exhausted, and unclaimed or with a lease older than `JOB_LEASE_SECONDS`, oldest `run_at` first; it stamps `claimed_at = now()` and counts the attempt.
2. **Run** the handler without any lock on the queue.
3. **Complete** (`completeJob`): `done_at = now()`, `last_error` cleared. When the handler returned `{ next }`, the same job (type, key, payload, tenant) is planned again at that time in the same transaction; a re-plan from inside the handler would be refused, because the running job still holds its key.
4. **Fail** (`failJob`): `last_error` scrubbed, lease released, `run_at = now() + min(2^attempts, 3600)` seconds. A type without a handler is a failure.

Complete and fail are guarded on `attempts` and `done_at is null`: if the lease expired and another worker claimed the job meanwhile, the late run changes nothing (`superseded`, logged as a warning) and the newer run owns it. A worker that dies mid-job leaves its lease to expire. A long job renews its lease with `touchJob`: `tenant.export` does so every `HEARTBEAT_MS` (`packages/db/src/portability/tenant-exports.ts`). An exhausted job stays in the table with its `last_error` until someone recovers it ([ops.md](ops.md)).

The job loop (`startJobWorker`) ticks every `JOBS_INTERVAL_MS`: plan the recurring jobs, then claim and run one batch; while a batch came back non-empty it ticks again at once.

The worker polls in **pools** (`JOB_POOLS`, `packages/api/src/jobs.ts`). A batch runs one job after another, so a ten-second `tenant.export` used to hold every job claimed behind it: a scheduled publish, an assist proposal, a mail reconcile. The `bulk` pool claims only `tenant.export` and `media.orphans`, one at a time, in a loop of its own; the default pool claims every other type (`claimJobs` with `excludeTypes`) and plans the recurring jobs. Both are the same role, queue and `SKIP LOCKED` claim (ADR 011 rule 4). The `newsletter` pool claims only `mailing.edition.deliver`, one at a time: a run talks to the mail provider for up to three minutes, and neither a scheduled publication nor an export should wait behind it or hold it up ([mail.md](mail.md#newsletter-editions)). The worker's `/readyz` follows the default pool: a bulk job may keep its pool busy for minutes.

## Tenant jobs and platform jobs

| Kind     | `tenant_id` | Runs as                                                                                                                                                                                                |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tenant   | set         | `tenantJob`: a unit of work as `mycel_app` under RLS, with `systemPrincipal(tenant, 'jobs:<type>', access)` carrying the tenant's current entitlements and status ([entitlements.md](entitlements.md)) |
| platform | null        | `platformJob`: on the operator connection, each function entering its own role per transaction                                                                                                         |

A tenant handler throws when the job has no tenant, a platform handler when it has one. `mail.reconcile`, `mailing.edition.deliver`, `mailing.automation.step`, `connections.run`, `connections.mailchimp.sync`, `assist.run` and `tenant.export` are tenant jobs that open their own units of work instead of one `tenantJob` transaction; `supporter.erase` and `person.erase` (ADR 034) run `applyErasures` for the tenant on its row, on the operator connection, whatever the tenant's status ([supporters.md](supporters.md#erasure), [export.md](export.md#person-erasure)). A platform job that works per tenant (`media.orphans`, `tenant.export.expire`, `assist.retention`) gets the tenant list from `mycel_platform` and visits each tenant in its own unit of work as `mycel_app`, never reading across tenants; in the first two, one tenant's failure is reported and the job fails after the others have run, so it is retried.

## Recurring platform jobs

`RECURRING_JOBS` (`packages/api/src/jobs.ts`). On every tick `ensureRecurring` inserts the next period of each, key `<type>:<label>` due at the period's start (UTC), as `mycel_worker`; a period already planned is one index conflict, so any number of workers plan it at most once, and a finished period is never planned again.

| Type                   | Cadence | Key label       | Runs as                                                                      |
| ---------------------- | ------- | --------------- | ---------------------------------------------------------------------------- |
| `events.partitions`    | monthly | `YYYY-MM`       | schema owner: monthly `events` partitions up to three months ahead (ADR 003) |
| `rate_limits.sweep`    | hourly  | `YYYY-MM-DDTHH` | `mycel_janitor`: expired rate-limit and login-attempt windows                |
| `media.orphans`        | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant: expired trash; rowless files older than a day        |
| `jobs.retention`       | daily   | `YYYY-MM-DD`    | `mycel_worker`: finished jobs older than `JOBS_RETENTION_DAYS`               |
| `audit.retention`      | daily   | `YYYY-MM-DD`    | `mycel_audit_janitor` ([audit.md](audit.md))                                 |
| `assist.retention`     | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant: expired assistance proposals                         |
| `tenant.export.expire` | daily   | `YYYY-MM-DD`    | `mycel_app` per tenant ([export.md](export.md))                              |
| `erasures.apply`       | daily   | `YYYY-MM-DD`    | `mycel_erasure` per tenant: the register again, as `mycel erasures apply`    |
| `retention.apply`      | daily   | `YYYY-MM-DD`    | `mycel_retention` per tenant: what passed its term (§ Retention)             |
| `donations.reconcile`  | hourly  | `YYYY-MM-DDTHH` | `mycel_app` per tenant: payments left open ([donations.md](donations.md))    |
| `subscriptions.charge` | hourly  | `YYYY-MM-DDTHH` | `mycel_app` per tenant: due gifts charged ([donations.md](donations.md))     |

## Public social conversation counts

The publisher keeps the post permalink in the article revision and the matching account under Site → Header and footer → Social profiles. With no profile, a different account or a disabled provider, the site shows the permalink by itself.

Set `SOCIAL_CONVERSATION_BLUESKY=1` on the web and worker to enable the fixed public Bluesky AppView. Set `SOCIAL_CONVERSATION_MASTODON_ORIGINS` to a comma-separated list of the exact HTTPS origins operated or approved by the installation. Both are off by default. Turning a provider off on both processes stops its refreshes and hides its cached values. The worker uses anonymous [Bluesky profile and post reads](https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/api-directory.mdx) and the [Mastodon status API](https://docs.joinmastodon.org/methods/statuses/#get). It follows no redirects, pins a freshly checked public DNS address for TLS, caps JSON at 128 KiB and gives each HTTPS request four seconds after DNS. The browser makes no provider request before a visitor follows the link.

When a provider is enabled, the hourly `social-conversation.plan` job schedules one `social-conversation.refresh:<tenant>` job per site. A separate worker pool starts at most eight distinct posts for a tenant at once, oldest attempts first. The job reads current published public article revisions under tenant RLS and claims each post at most once per 50 minutes. The request runs outside the database transaction.

Only counts and their timestamps are cached. A successful check lasts at most two hours, including zero counts. Temporary errors leave the last successful expiry in place. A confirmed withdrawal clears the snapshot when processed. The article's HTML ETag includes displayed counts, and responses containing them require revalidation before reuse. Cache rows are rebuildable installation data and are pruned after a day without an attempt when the tenant refresh runs.

## Retention

`jobs.retention` (`deleteFinishedJobs`, `packages/db/src/operations/ops.ts`) deletes jobs whose `done_at` is older than `JOBS_RETENTION_DAYS`, in batches until none are left. The restrictive delete policy `worker_retention` (migration 0014) lets `mycel_worker` delete finished rows only, so an open job, exhausted or not, can never disappear whatever the query asks.

`retention.apply` (`applyAllRetention` in `packages/api/src/jobs.ts`, `applyRetention` in `packages/db/src/infra/retention.ts`) enforces four terms per tenant. It reads the tenant's retention setting as `mycel_app`, takes the cut-offs from core (`retentionCutoffs`, `packages/core/src/ops/retention.ts`) and deletes as `mycel_retention` (migration 0048) inside that tenant's transactions, 500 rows at a time. Only the operator connection may enter that role, and every one of its policies tests the tenant, so a run never reaches another tenant's rows. It runs for a suspended tenant too: it accepts no command, publishes nothing and sends nothing.

| What            | Term                                                                                                | Kept longer while                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| outbox event    | 30 days after `processed_at`                                                                        | a `mail.reconcile` job that is not done names it; an event that never processed is not a candidate ([ops.md](ops.md))                          |
| mail intent     | goes with its outbox event                                                                          | its event exists                                                                                                                               |
| form submission | 24 calendar months after `created_at`, or the fewer months the tenant set (`site.retention.update`) | an unprocessed outbox event or an open `mail.reconcile` job's event names it, or a connection intent planned from it is `pending` or `unknown` |
| admission seat  | 7 days after `admitted_at` (`ADMISSION_WINDOW_MS`)                                                  | never                                                                                                                                          |
| reader sign-in  | 90 days after `occurred_at`, or the days the tenant set (0 to 365, `readerActivityDays`)            | the supporter's `last_seen_at` does not hold it yet (ADR 019 rule 7)                                                                           |

A row on its cut-off stays; the first moment after it goes at the next daily run, so a row can outlive its term by a day. Months are calendar months in UTC with the day clamped to the month's last (`monthsBefore`): 31 March minus one month is 28 February, 29 in a leap year. `site.retention.get` (`forms:read`) and `site.retention.update` (`tenant:admin`, versioned like the other site settings) read and set `submissionMonths`, 1 to 24, and `readerActivityDays`, 0 to 365; there is no unlimited option, a site that never set them keeps 24 months and 90 days, and a lower term applies to what is already stored. A reader sign-in (`reader.signed_in`) past its term is deleted from the supporter's log; the projection's `lastSeenAt` keeps the last one, and a re-fold after a late event never moves it, `firstSeen` or `lastActivity` back (`refold`, core `supporters/model.ts`). At 0 only `lastSeenAt` stays after the next daily run. The setting travels in an export with `site_settings`; the admin sets both on the site settings page (section Bewaartermijnen), and the reader page tells a reader the site's term.

The exceptions are there so no effect loses its source: `mail.reconcile` rebuilds a message from the outbox event and the submission, and a connector dispatch rereads the submission. Without them such an effect fails closed (no mail, no dispatch), but an attempt whose outcome at the provider is unknown could never be settled. They are visible, not silent: a job that exhausted its attempts and a dead outbox event show on the status page ([ops.md](ops.md)) and hold their rows until someone retries or closes them. An intent that is still unsettled when its event goes (its reconcile job was closed) goes with it: the intent holds a keyed digest of the recipient that an erasure finds through the event only, so it must not outlive the event.

Two readers outlive a row on purpose and are built for it. A delivery record past its term is not shown as mail that never started: `form.delivery.get` reports `expired` when neither the intent nor its event is kept, and `form.mail.replay` then schedules nothing ([forms.md](forms.md)). And the recurring Mailchimp comparison goes on after the submission is gone: a withdrawal at the provider (unsubscribed, cleaned, archived or absent) is applied from the receipt, the intent and the supporter that still holds the address the receipt's member hash was made of, so the term never cuts a supporter off from their own unsubscribe ([connections.md](connections.md)). What needs the submission ends with it: a provider-owned confirmation that arrives after the term grants nothing. That also holds for an address that was erased and signed up again: the receipt of the live lifecycle is the evidence for the withdrawal (ADR 032 rule 3), so its submission goes at its term like any other, and an erasure on request still removes it earlier.

The policies of `mycel_retention` hold five floors whatever a statement asks: an unprocessed outbox event cannot be deleted, a mail intent cannot be deleted while its event exists, a submission younger than 28 days cannot be deleted, an admission seat inside its seven-day window cannot be deleted, and of the supporter's log only a `reader.signed_in` event that the projection's `last_seen_at` already holds can be deleted (migration 0071). Retention does not touch the rest of the supporter's event log, the projection or consent, nor the form definitions pinned in other submissions; erasure on request stays [supporters.md](supporters.md) § Erasure. Backups keep what they hold for their own window ([self-hosting.md](../self-hosting.md)).

## The outbox

`outboxEventBus` writes an event into `outbox` in the use case's own transaction. `drainOutbox` (`packages/db/src/operations/outbox.ts`, as `mycel_worker`) claims a batch of due events (`processed_at is null`, `available_at <= now()`, `attempts < MAX_ATTEMPTS`) in id order and, unlike jobs, delivers them inside that claim transaction. Each subscriber that wants the type and is not yet in `delivered_to` handles the event; one that succeeds is added to `delivered_to`, so a retry runs only the others. When every subscriber delivered, `processed_at` is set; otherwise `attempts` grows, `last_error` holds the scrubbed message and `available_at` moves `min(2^attempts, 3600)` seconds ahead. After `MAX_ATTEMPTS` failed passes an event is dead: no longer drained, counted by `queueLag`, recoverable only by the hoster. The outbox loop (`startOutboxWorker`) ticks every `OUTBOX_INTERVAL_MS`, at once again while there is a backlog. `readOutboxEvent` is the outbox's second reader, for `mail.reconcile`.

## Constants

| Constant                | Value                     | Where                                           | Why                                                                      |
| ----------------------- | ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `JOB_LEASE_SECONDS`     | 300                       | `packages/db/src/operations/jobs.ts`            | a claim older than this is free again; its worker is presumed dead       |
| `max_attempts`          | 10                        | `packages/db/migrations/0009_jobs.sql`          | column default; an exhausted job waits for recovery                      |
| job backoff             | `min(2^attempts, 3600)` s | `packages/db/src/operations/jobs.ts`            | 2, 4, 8 ... seconds after each failure, at most an hour                  |
| job batch size          | 10                        | `packages/db/src/operations/jobs.ts`            | jobs per claim (`claimJobs`)                                             |
| pool batch size         | 1                         | `packages/db/src/operations/jobs.ts`            | jobs per claim in a pool (`JobPool`), so a waiting lease never runs out  |
| `JOBS_INTERVAL_MS`      | 5 s                       | `packages/api/src/runtime/compose.ts`           | job loop tick when the queue is empty                                    |
| `HEARTBEAT_MS`          | 60 s                      | `packages/db/src/portability/tenant-exports.ts` | how often a running export renews its lease, well inside the 300 s lease |
| `MAX_ATTEMPTS`          | 10                        | `packages/db/src/operations/outbox.ts`          | failed passes before an outbox event is dead                             |
| outbox backoff          | `min(2^attempts, 3600)` s | `packages/db/src/operations/outbox.ts`          | the same schedule as jobs                                                |
| outbox batch size       | 50                        | `packages/db/src/operations/outbox.ts`          | events per claim (`drainOutbox`)                                         |
| `OUTBOX_INTERVAL_MS`    | 1 s                       | `packages/api/src/runtime/compose.ts`           | outbox loop tick when nothing is pending                                 |
| `JOBS_RETENTION_DAYS`   | 30 (1 to 3650)            | `packages/api/src/runtime/config.ts`            | env; finished jobs older than this are deleted daily                     |
| retention batch         | 1000                      | `packages/db/src/operations/ops.ts`             | rows per delete, so no transaction holds many row locks                  |
| `OUTBOX_RETENTION_DAYS` | 30                        | `packages/core/src/ops/retention.ts`            | decided term for a processed outbox event                                |
| submission months       | 24 (1 to 24)              | `packages/core/src/ops/retention.ts`            | decided default and ceiling; the tenant may choose fewer                 |
| `RETENTION_BATCH`       | 500                       | `packages/db/src/infra/retention.ts`            | rows per `retention.apply` transaction                                   |
