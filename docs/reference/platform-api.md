# Platform API

How a hoster creates tenants and sets what each may use (ADR 015 rule 4, TODO #16). The hosted service's billing system (for Bureau Bolster: the client portal) calls it; a self-hoster uses the same functions through `npm run platform` and never needs the API. Prices, tier names and presets are the hoster's business and never appear in this repository.

These routes are **not** use cases: they run under no tenant (ADR 002 rule 4), so they are not in the registry, not MCP tools and not in `/openapi.json`. They run as the `mycel_platform` role, entered from the authentication login; the API never holds the schema owner's credentials (ADR 011 rule 1). That role may read and insert tenants, update their entitlements and status, and read and insert platform hostnames, and nothing else. The functions behind them are `packages/db/src/platform.ts`; `npm run platform` enters the same role from the operator connection.

## Enabling it

| Variable              | Meaning                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_API_TOKEN`  | Bearer token, at least 32 characters. Unset: `/platform/*` does not exist (404). Needs nothing but `AUTH_DATABASE_URL`: the routes run as `mycel_platform`, entered from the authentication login (ADR 011 rule 1). |
| `PLATFORM_CREDIT_URL` | Where the "Runs on Mycel" footer credit links (ADR 015 rule 5). Default `https://mycel.dev`.                                                                                                                        |

The token is compared in constant time. It grants everything this page describes for every tenant, so it lives in the hoster's secret store and nowhere else, and the routes should not be reachable from the public internet (the Caddy example keeps `/internal/*` closed; do the same for `/platform/*` unless the portal calls it over a private network).

## Routes

Every request carries `Authorization: Bearer <PLATFORM_API_TOKEN>`; without it, or with a wrong one, the answer is `401` Problem Details. Errors are Problem Details (`urn:mycel:problem:<code>`) like the tenant API.

| Method and path                          | Body                                                     | Answer                             |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `POST /platform/tenants`                 | `{ slug, name, locales, defaultLocale?, entitlements? }` | `201` tenant; `409` on a collision |
| `GET /platform/tenants`                  |                                                          | `{ tenants: [tenant] }`            |
| `GET /platform/tenants/:id`              |                                                          | tenant, or `404`                   |
| `PUT /platform/tenants/:id/entitlements` | the full document (any subset of the keys below)         | tenant, `400` on an unknown key    |
| `PUT /platform/tenants/:id/status`       | `{ status: "active" \| "suspended" }`                    | tenant                             |

A **tenant** in an answer:

```json
{
  "id": "0190…",
  "slug": "example",
  "name": "Example",
  "defaultLocale": "nl",
  "locales": ["nl", "en"],
  "status": "active",
  "primaryHostname": "example.mycel.site",
  "storedEntitlements": { "remove_branding": false, "supporters.max": 250 },
  "entitlements": { "mailing.enabled": true, "…": "…", "supporters.max": 250 }
}
```

`storedEntitlements` is exactly what the hoster last sent; `entitlements` is that document merged over the defaults, which is what the tenant gets. `PUT …/entitlements` replaces the stored document: send the whole thing, not a patch.

`POST /platform/tenants` refuses an existing slug, a slug whose platform hostname (`<slug>.<PLATFORM_DOMAIN>`) is the host of `PUBLIC_BASE_URL` or a development host, and a slug whose platform hostname some tenant already holds. It creates the platform hostname, verified and primary, in the same transaction.

Every mutation writes one row to the tenant's audit log in the same transaction (`docs/reference/audit.md`): actor kind `platform`, actor id the first eight hex characters of the SHA-256 of the token (`npm run platform` writes `cli`), operation `platform.tenant.create`, `platform.set_entitlements` or `platform.set_status`. A refused mutation writes nothing. The server log keeps one operational line per mutation as well.

## Stuck work

Since TODO #17c (migration 0016) the hoster sees what is stuck on every site: jobs that used up their attempts, outbox events that failed ten passes without reaching every subscriber, and mail intents whose outcome is unknown or that were given up (`docs/reference/mail.md`). These routes run as `mycel_ops`, a role of its own entered from the same authentication login, whose grants are on columns: a job's `payload` and an event's `props` and `actor` cannot be read by it, whatever the query; its policies reach only stuck rows. The functions are `packages/db/src/recovery.ts`.

| Method and path             | Query                            | Answer                                                                                                                  |
| --------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /platform/ops/summary` |                                  | `{ tenants: [{ tenantId, slug, name, status, exhaustedJobs, deadEvents, unknownMail, abandonedMail }] }`                |
| `GET /platform/ops/jobs`    | `tenantId?`, `cursor?`, `limit?` | `{ items: [{ id, tenantId, type, key, runAt, attempts, maxAttempts, lastError, createdAt }], nextCursor }`              |
| `GET /platform/ops/outbox`  | `tenantId?`, `cursor?`, `limit?` | `{ items: [{ id, tenantId, type, occurredAt, attempts, deliveredTo, lastError, availableAt }], nextCursor }`            |
| `GET /platform/ops/mail`    | `tenantId?`, `cursor?`, `limit?` | `{ items: [{ tenantId, key, subscriber, eventId, state, attempts, attemptedAt, abandonedAt, lastError }], nextCursor }` |

The summary lists only tenants with something stuck, plus one row with `tenantId: null` for platform jobs. Pages are oldest first (jobs and events by id, mail by key); `limit` defaults to 50, at most 200; `nextCursor` is null on the last page. Every `lastError` is scrubbed again on the way out (`scrubText`). The lag figures stay on the worker's `/metrics` (`observability.md`).

**Recovery is not here yet.** The brief has `POST /platform/ops/jobs/:id/retry|close` and `POST /platform/ops/outbox/:id/retry` as `mycel_ops`, but under the policies above Postgres refuses the update: it checks the new row of an UPDATE whose WHERE reads a column against the role's SELECT policies too, and a recovered row is no longer stuck. Which grant to widen is an open decision of the #17c review. Until then the hoster recovers a site's job the way its administrator does (`ops.job.retry`, `ops.job.close`, below) and a dead event with SQL as the schema owner. There is no route by which support acts as a tenant's administrator.

A site's own administrators see their stuck jobs and mail on `/admin/<slug>/status` and recover a job there (use cases `ops.status`, `ops.job.retry`, `ops.job.close`, capability `tenant:admin`, audited like every command); dead outbox events are the hoster's only.

## The entitlements document

Flat keys, the names of ADR 015 rule 2. Missing keys get the default; an empty document means everything with these limits.

| Key                       | Kind              | Default       | Enforced in                                                |
| ------------------------- | ----------------- | ------------- | ---------------------------------------------------------- |
| `mailing.enabled`         | switch            | `true`        | (no consumer yet; TODO #22B)                               |
| `donations.enabled`       | switch            | `true`        | (no consumer yet; fase 4)                                  |
| `custom_domain`           | switch            | `true`        | `tenant.hostnames.add`                                     |
| `api_keys`                | switch            | `true`        | `tenant.keys.create`                                       |
| `remove_branding`         | switch            | `false`       | the public layout: `false` shows the credit                |
| `blocks`                  | `{ type: false }` | `{}` (all on) | (TODO #8b, per block type when a tree is saved)            |
| `supporters.max`          | limit             | 100 000       | `forms.submit`, for a new address only                     |
| `mail.monthly_max`        | limit             | 1 000 000     | (no consumer yet; TODO #22B)                               |
| `media.storage_max_bytes` | limit             | 50 GiB        | `media.upload` (original plus every variant)               |
| `operators.max`           | limit             | 50            | `tenant.members.invite` (members plus pending invitations) |
| `custom_domains.max`      | limit             | 20            | `tenant.hostnames.add`                                     |

A refused action is `403` with `urn:mycel:problem:limit_exceeded` and an issue naming the key (`entitlements.limit.supporters.max`, `entitlements.feature_off`); the admin and the public pages turn that into "ask your host", never a price. Only growth is blocked: what a tenant already has stays published (ADR 015 rule 7).

**Status** is not an entitlement. A `suspended` tenant answers every command with `403 urn:mycel:problem:suspended`, except export commands; queries keep working, so the public site stays readable and the admin stays open.

When a change shows: the API and the admin read entitlements and status with the credential on every request, so at once; the public site reads them with the hostname, cached for thirty seconds per hostname.

## The CLI

```sh
npm run platform -- tenants list
npm run platform -- tenants create <slug> <name> nl,en
npm run platform -- entitlements set <slug> '{"supporters.max": 250}'
npm run platform -- status set <slug> suspended
npm run platform -- ops summary
npm run platform -- ops list jobs|outbox|mail [<slug>]
```

It reads `.env` and needs `DATABASE_URL` (the operator role). `mycel setup` (TODO #18) takes it over.
