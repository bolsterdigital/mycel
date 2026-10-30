# Stuck work and recovery

Three kinds of background work can stall without anyone noticing: a job that used up its attempts, an outbox event that failed every pass without reaching every subscriber, and a mail intent whose outcome is unknown or that was given up. This module makes them visible and recoverable, for a site's own administrators through three use cases in `packages/core/src/ops/`, and for the hoster platform-wide through `/platform/ops/*` and the CLI ([platform-api.md](platform-api.md)), with one set of rules in `packages/db/src/infra/recovery.ts` (migration 0016; ADR 011 rules 1 and 2, [`../adr/011-background-roles-and-outbox.md`](../adr/011-background-roles-and-outbox.md)). The queues themselves are in [jobs.md](jobs.md), mail intents in [mail.md](mail.md). Nobody acts "as" someone else: a tenant administrator recovers as themselves, the hoster as the platform, and both are audited ([audit.md](audit.md)).

## What counts as stuck

| Kind              | Condition                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| exhausted job     | `done_at is null and attempts >= max_attempts`                                                                                 |
| dead outbox event | `processed_at is null and attempts >= MAX_ATTEMPTS` (10, `packages/db/src/outbox.ts`)                                          |
| unresolved mail   | attempted, not sent, and either abandoned or with no running lease: the `unknown` and `abandoned` states of [mail.md](mail.md) |

A job is **recoverable** when it is exhausted and no run holds its lease (`claimed_at` null or older than `JOB_LEASE_SECONDS`). A job on its last attempt counts as exhausted from the claim on; resetting it while that run is still going would let a second worker run it beside the first, so that is refused.

## The site's view: `ops.status.get`

A query, capability `tenant:admin`, behind `/admin/<tenant>/status` in the web app. It returns:

| Field       | Content                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs`      | the tenant's exhausted jobs, oldest first, at most `STATUS_JOBS`: `id`, `type`, `key`, `attempts`, `maxAttempts`, `lastError`, `createdAt`                        |
| `mails`     | unresolved mail intents (`MailSendsRepository.unresolved`): `state`, `subscriber`, `attempts`, `attemptedAt`, `abandonedAt`, `lastError`                          |
| `erasures`  | the erasure register against backups, counts only: `registered`, `unsecured`, `oldestUnsecuredAt`, `late` (unsecured for longer than `ERASURE_UNSECURED_WARN_MS`) |
| `audit`     | the `STATUS_AUDIT` most recent audit rows                                                                                                                         |
| `diagnosis` | the redacted plain text below                                                                                                                                     |

Platform jobs (`tenant_id` null) and dead outbox events never appear here: dead events are the hoster's to recover. The jobs are read through `ctx.jobRecovery` (`jobRecoveryRepository`, as `mycel_app` under `tenant_isolation`), whose column grant on `jobs` leaves out `payload`.

## The diagnosis and redaction

`buildDiagnosis` (`model.ts`) builds fixed-shape English text an administrator reads before copying it to support; nothing is ever sent on their behalf, and there is no structured export. It holds the site slug, the time, one line per exhausted job (type, key cut to `DIAGNOSIS_KEY_CHARS`, attempts, since, error), one per unresolved mail, the unsecured erasure count, and the request ids of the `DIAGNOSIS_FAILED_REQUESTS` most recent refused or failed commands. It never holds a payload, a correlation hash or a provider id.

Error text is scrubbed when it is written (`failJob`, `drainOutbox`, the mail recorder) and again wherever it is shown: `toStuckJob` and the `ops*` listings apply `scrubText` (`packages/core/src/util/scrub.ts`) on the way out, and the diagnosis once more, collapsing whitespace to one line. `scrubText` replaces anything shaped like an e-mail address (also URL-encoded) with `[email]`, and a bearer credential or a Mycel API key with `[secret]`.

## Recovering a job: `ops.job.retry`, `ops.job.close`

Two commands, capability `tenant:admin`, input `{ id }`, output `{ id }`, audited by the Invoker like every command.

| Use case        | Change                                                | Afterwards                                                          |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `ops.job.retry` | `attempts = 0`, `run_at = now()`, `claimed_at = null` | runs as soon as a worker is free; `last_error` stays until that run |
| `ops.job.close` | `done_at = now()`                                     | never runs; `last_error` stays; the open key is free again          |

Both update only a recoverable row of the tenant. An id the tenant cannot see is `not_found`; a visible job that is not recoverable (attempts left, running right now, already done) is `conflict`. Closing a `mail.reconcile` job leaves its intent unknown and visible; an intent itself is never closed by hand.

## The hoster's view: `mycel_ops`

The `ops*` functions in `recovery.ts` serve `/platform/ops/*` and the `mycel ops` CLI. Each is one transaction as `mycel_ops`, a `nologin` role entered with `set local role` from the authentication login (API) or the operator connection (CLI). Its rights (migration 0016):

| Table        | Read                                                          | Change                                                                                                        |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `jobs`       | every column but `payload`, every row                         | `attempts`, `run_at`, `claimed_at`, `done_at`, `last_error` of an exhausted row, into a retry or a close only |
| `outbox`     | every column but `actor` and `props`, every row               | `attempts`, `available_at`, `last_error` of a dead row, into `attempts = 0` only                              |
| `mail_sends` | every column of attempted, unsent rows (no address is stored) | none                                                                                                          |
| `tenants`    | `id`, `slug`, `name`, `status`; never `entitlements`          | none                                                                                                          |

Reading covers every row's metadata, not only stuck ones, because Postgres checks the new row of an update against the select policies too and a recovered row is no longer stuck. `opsSummary` counts stuck work per tenant (exhausted jobs, dead events, unknown and abandoned mail), only for tenants with something stuck, plus one row with `tenantId: null` for platform jobs. `opsJobs`, `opsDeadEvents` and `opsUnresolvedMail` page oldest first (by id; mail by key), optionally for one tenant. `opsRetryJob` and `opsCloseJob` apply the tenant's rules to any tenant's jobs and the platform's own; `opsRetryEvent` sets a dead event to `attempts = 0`, due now, keeping `delivered_to` so only the subscribers that never delivered run again. Each recovery writes its audit row as `mycel_platform` in the same transaction (operation `platform.ops.job.retry`, `platform.ops.job.close` or `platform.ops.outbox.retry`, in the row's tenant's log, `tenant_id` null for a platform job); a recovery that changed nothing writes nothing. Queue lag figures are not here; they are on the worker's `/metrics` ([observability.md](observability.md)).

## Constants

| Constant                    | Value       | Where                                     | Why                                                                 |
| --------------------------- | ----------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `STATUS_JOBS`               | 100         | `packages/core/src/ops/service.ts`        | exhausted jobs on the status page; the platform API pages the rest  |
| `STATUS_AUDIT`              | 20          | `packages/core/src/ops/service.ts`        | recent audit rows on the status page                                |
| `DIAGNOSIS_FAILED_REQUESTS` | 5           | `packages/core/src/ops/service.ts`        | failed request ids in the diagnosis                                 |
| `DIAGNOSIS_KEY_CHARS`       | 48          | `packages/core/src/ops/model.ts`          | enough of a job key to recognise the subject, not to reconstruct it |
| `ERASURE_UNSECURED_WARN_MS` | 1 h         | `packages/core/src/supporters/erasure.ts` | when an erasure no backup holds yet is shown as late                |
| ops page size               | 50, max 200 | `packages/db/src/infra/recovery.ts`       | default and ceiling of `limit` on the `ops*` listings               |
