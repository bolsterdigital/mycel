# Observability

Logs, error reports, health and metrics of every Mycel process (TODO #17a). The hoster reads stdout; nothing here ships logs anywhere. The reasoning is in ADR 008 (our own code before a dependency), 011 (who may read the queues) and 019 rule 8 (erasure covers every copy, and a log line is a copy). The audit log is [audit.md](audit.md) (#17b); the per-tenant status page and recovery of stuck work are #17c.

## Log lines

Every process writes one JSON object per line: api, web and worker to stdout, the MCP server to stderr (its stdout is the protocol channel).

```json
{
  "time": "2026-10-22T12:00:00.000Z",
  "level": "info",
  "msg": "request",
  "service": "api",
  "requestId": "0192b1c4-...",
  "tenantId": "0192a...",
  "method": "POST",
  "route": "/v1/:name",
  "status": 200,
  "durationMs": 12
}
```

| Field                                     | Where it comes from                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `time`, `level`, `msg`, `service`         | every line; `service` is `api`, `web`, `worker` or `mcp`; fields cannot overwrite these four                                |
| `requestId`                               | api and web: a valid incoming `X-Request-Id` (`^[A-Za-z0-9-]{8,64}$`, Caddy may set one), else a UUIDv7                     |
| `tenantId`                                | api: after the API key is authenticated; web: once the site is resolved; worker: the job's or event's                       |
| `job`                                     | worker: the job type the line belongs to                                                                                    |
| `eventId`                                 | worker: the outbox event a subscriber is handling                                                                           |
| `actor`                                   | when logged: `operator:<id>`, `api-key:<id>`, `agent:<keyId>`, `system:<job>` or `anonymous` (`actorRef`)                   |
| `method`, `route`, `status`, `durationMs` | the access line, one per request; `route` is the pattern (`/v1/:name`, a SvelteKit route id), never the path with its query |

The request id is echoed in the `X-Request-Id` response header. Access lines of `/healthz`, `/readyz` and `/metrics` are written at `debug`, so a probe every few seconds does not drown the log. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the lowest level written.

Core code logs through `ctx.log`, the `Logger` port; its fields are scalars only (`LogFields`), so an input, a payload or a principal object cannot ride along.

## What never goes into a log

- **An e-mail address.** Every string the logger writes, the message and every field value, passes `scrubText` (`packages/core/src/util/scrub.ts`), which replaces anything shaped like an address (also `%40`-encoded, without a dot, upper case, IDN) with `[email]`. It is generous on purpose: a package version such as `pkg@1.2.3` is scrubbed too.
- **A credential.** `Bearer …` and Mycel API keys (`mycel_` plus 43 characters) become `[secret]`.
- **A person's data by key.** Fields named `email`, `to`, `recipient`, `address`, `input`, `payload`, `props`, `body`, `authorization` or `cookie` are dropped, not scrubbed.
- **A principal.** The operator actor carries an address; log `actorRef(actor)` instead.

The same `scrubText` runs over every error text Mycel stores: `jobs.last_error`, `outbox.last_error` and `mail_sends.last_error`, which #17c shows to administrators. `packages/api/src/redaction.conformance.test.ts` calls every registered use case as an operator with an address, over a unit of work that fails quoting an address, and checks that neither stdout nor the error tracker's envelope contains it.

## Error reports

Unexpected failures go to the `ErrorReporter` port. A `UseCaseError` (not found, forbidden, invalid input, conflict, limit, suspended) is an answer, not a failure, and is never reported.

| Who reports                           | What                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| api `onError`, platform API `onError` | any non-`UseCaseError` thrown by a route                 |
| web `handleError`                     | errors of kind `unknown` (thrown by our code)            |
| MCP tool call                         | any non-`UseCaseError`; the caller sees `internal error` |
| worker job loop, outbox loop          | a failing handler or subscriber, a failing pass          |
| `media.orphans`                       | each tenant that failed inside the platform job          |

The console reporter always writes one `error` line with `errorType`, the scrubbed message and the scrubbed stack including the `cause` chain. With `ERROR_REPORTING_DSN` set, a Sentry envelope is posted as well: fire and forget, two-second time-out, and a tracker that is down costs one `warn` line, never a failed request. The envelope holds the exception (type, scrubbed message, frames from the scrubbed stack, the `cause` chain), `environment` (`ERROR_REPORTING_ENVIRONMENT`, default `NODE_ENV`) and tags `service`, `requestId`, `tenantId`, `job`. No request body, headers, cookies, user or IP address.

**GlitchTip** (self-hosted, can run in the EU) accepts Sentry envelopes: create a project and put its DSN in `ERROR_REPORTING_DSN`. `@sentry/node` is deliberately not used; it instruments everything it can reach and sends request data by default.

## Health, readiness and metrics

| Process | `/healthz`             | `/readyz`                                                                                                                                                                  | `/metrics`                                                 |
| ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| api     | process lives          | `select 1` over the `mycel_app` connection within 1 s: 200 `{ db: "ok" }` or 503                                                                                           | with `Authorization: Bearer $METRICS_TOKEN`; otherwise 404 |
| web     | process lives          | the same over its own connection                                                                                                                                           | none                                                       |
| worker  | process lives (`PORT`) | database answers, both loops finished a pass within `3 × interval + 30 s`, outbox and job lag below `READY_MAX_LAG_SECONDS` (default 900); body always carries the numbers | on the health port, no token                               |

`/healthz` stays the container healthcheck, so a database outage or a backlog takes a process out of rotation (readiness) but never into a restart loop. The Caddyfile example (`docs/reference/caddy/`) answers 404 for `/readyz`, `/metrics` and `/internal/*` from outside; the worker's health port is never routed.

The api and web processes do not compute queue lag: they have no owner credentials and may not read the queues (ADR 011 rule 1). The worker does, as `mycel_worker` (`queueLag` in `packages/db/src/ops.ts`), with aggregates only.

### Metric names

| Name                          | Type    | Labels                                                 | Process |
| ----------------------------- | ------- | ------------------------------------------------------ | ------- |
| `mycel_http_requests_total`   | counter | `method`, `route`, `status` (`2xx`, `4xx`, `5xx`)      | api     |
| `mycel_use_case_errors_total` | counter | `code`                                                 | api     |
| `mycel_outbox_lag_seconds`    | gauge   |                                                        | worker  |
| `mycel_outbox_dead`           | gauge   |                                                        | worker  |
| `mycel_jobs_lag_seconds`      | gauge   |                                                        | worker  |
| `mycel_jobs_exhausted`        | gauge   |                                                        | worker  |
| `mycel_jobs_runs_total`       | counter | `type`, `result` (`completed`, `failed`, `superseded`) | worker  |

Never a tenant id as a label: the cardinality would grow with every customer and a scrape would list them. The gauges are computed when `/readyz` or `/metrics` is requested. No histograms yet.

### What the lag numbers mean

- **`outboxLagSeconds`**: age of the oldest event that has not reached every subscriber and is not dead, waiting backoff included. A healthy worker keeps it at seconds.
- **`outboxDead`**: events that failed ten times (`OUTBOX_MAX_ATTEMPTS`) without reaching every subscriber. They are no longer drained; #17c makes them visible and retryable.
- **`jobsLagSeconds`**: how long the oldest due job that a worker could claim has been waiting. A job in its retry backoff is not due yet and does not count.
- **`jobsExhausted`**: open jobs that used up their attempts. They stay in the table with `last_error` until someone looks (#17c); retention never deletes them.

A worker that was down across a period boundary skips that period of a recurring job: the next pass plans the next period, not the missed one. For `events.partitions` the three-month margin catches that once; for the hourly sweep and the daily jobs, the next run does the same work.

`runJobs` counts a job whose handler finished after its five-minute lease expired, while another worker had taken it, as `superseded`, logged at `warn`, not as `completed`: the other run owns the job.

## Job retention

The daily `jobs.retention` job deletes jobs that finished more than `JOBS_RETENTION_DAYS` (default 30) ago, as `mycel_worker`, in batches of 1000. Migration 0014 grants the delete under a **restrictive** policy `using (done_at is not null)`: an open job, exhausted or not, cannot be deleted whatever the query says. With 30 days the table holds a few thousand finished rows (about 720 hourly sweeps, 30 of each daily job, plus tenant jobs).

## Environment

| Variable                      | Default    | Meaning                                                                  |
| ----------------------------- | ---------- | ------------------------------------------------------------------------ |
| `LOG_LEVEL`                   | `info`     | lowest level written; an unknown value is `info`                         |
| `ERROR_REPORTING_DSN`         | empty      | Sentry or GlitchTip DSN; empty means log lines only                      |
| `ERROR_REPORTING_ENVIRONMENT` | `NODE_ENV` | the tracker's environment                                                |
| `METRICS_TOKEN`               | unset      | bearer token for the api's `/metrics` (min. 32 characters); unset is 404 |
| `READY_MAX_LAG_SECONDS`       | `900`      | worker `/readyz` fails at this outbox or job lag                         |
| `JOBS_RETENTION_DAYS`         | `30`       | finished jobs older than this are deleted daily                          |
