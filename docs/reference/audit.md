# Audit log

Who did what on a site, and how it ended (PR #19). Every command, over HTTP, MCP or the web app, leaves exactly one row in `audit_log`; every mutation of the platform API and `npm run platform` leaves one too. The log names its actors by id and its inputs by a keyed hash: it is an account of actions, not a copy of the data (ADR 019 rule 8). Logs, error reports and metrics are in [observability.md](observability.md).

## What a row holds

| Column        | Content                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | UUIDv7                                                                                                                                       |
| `tenant_id`   | the tenant the command ran in; a command always has one (every `Principal` carries a tenant)                                                 |
| `occurred_at` | when the row was written                                                                                                                     |
| `actor_kind`  | `operator`, `api-key`, `agent`, `system`, `anonymous` or `platform`                                                                          |
| `actor_id`    | operator id, API key id, the agent's key id, the job name, null for an anonymous visitor; `platform`: token fingerprint, `cli` or `seed`     |
| `operation`   | the use-case name (`media.upload`) or `platform.tenant.create`, `platform.tenant.import`, `platform.set_entitlements`, `platform.set_status` |
| `effect`      | the command's ADR 018 effect (`publish`, `send`, `export`, `refund`), when it has one                                                        |
| `input_hash`  | HMAC-SHA256 of the canonical input, hex (below)                                                                                              |
| `result`      | `ok`, a use-case error code (`forbidden`, `invalid_input`, `suspended`, `limit_exceeded`, `not_found`, `conflict`) or `error`                |
| `request_id`  | the request id of the front's log context, so a row leads to its log lines                                                                   |
| `subject_id`  | the `id` of the command's output, when it has one (the media item uploaded, the key created)                                                 |

Never in a row: an e-mail address (an operator is its operator id), an IP address or its hash, the input itself, a token. The registry conformance runs every command and fails when any column of any row contains `@`.

Queries are not audited: reading is not an action in this log, and its volume would bury the actions. Exports are commands (`effect: 'export'`) and are audited.

## When the row is written

`Invoker.run` (`packages/core/src/invoke.ts`) writes it, never a handler:

- **Success**: after the output is validated, inside the command's own transaction. If anything later rolls that transaction back, the `ok` row goes with it.
- **Refusal or failure** (suspension, a missing capability, invalid input, a use-case error, any other exception): in a short transaction of its own with the principal's tenant context, after the command's transaction rolled back. The original error is then rethrown unchanged; if writing the row fails, that is logged and reported to the error tracker and the original error still wins.

So a successful command without its row cannot exist, and a refused one has its row unless the database itself is unreachable.

The platform functions (`packages/db/src/platform.ts`) write their row inside their own `mycel_platform` transaction, only when the mutation took effect: a refused slug or an unknown tenant id changed nothing and writes nothing.

## The input hash

`input_hash = hex(hmac-sha256(AUDIT_HASH_KEY, canonical-json(input)))`. Canonical JSON sorts object keys at every depth and has no whitespace, so the same input in another key order hashes the same. A refused input that did not parse is hashed as it arrived.

The hash is keyed because many inputs are little more than an address: a plain SHA-256 of `{"email": "..."}` can be reversed with a list of addresses. With the key, support can answer "was this the request with these exact values?" by hashing the candidate input under the same key; without it, nobody can. The hash is not shown to tenant administrators (`audit.list` leaves it out).

`AUDIT_HASH_KEY` is required in production (the process refuses to start without it) and at least 16 characters. Outside production an unset key falls back to a fixed development key; `.env.example` and CI set one. Rotating the key makes every older hash unlinkable to any input, which is also the way to retire them early.

## Who can do what

| Role                  | Rights on `audit_log`                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `mycel_app`           | `select`, `insert` under `tenant_isolation` (its own tenant); no `update`, no `delete`          |
| `mycel_platform`      | `insert` of rows with `actor_kind = 'platform'` only (policy `platform_audit`)                  |
| `mycel_audit_janitor` | `select` and `delete`, both only on rows older than 30 days (policies `audit_retention[_read]`) |

Nobody updates a row. The 30-day floor is in the database, so neither a wrong `AUDIT_RETENTION_DAYS` nor a hand-written `delete ... where id = ...` can erase a fresh trail.

## Retention

The daily recurring job `audit.retention` deletes rows older than `AUDIT_RETENTION_DAYS` (default 400: a year-end review still sees the whole year; minimum 30) across tenants, in batches of 1000, as `mycel_audit_janitor`. A per-tenant retention setting is not built; it comes when a tenant asks for one.

**Volume.** One row per command: a busy campaign site with a few thousand signups a day writes a few thousand rows a day, each some 300 bytes with its indexes. At 400 days a single such tenant stays well under a gigabyte. Partition by month on `occurred_at` (dropping a partition instead of deleting rows, like `events` in ADR 003) once the platform writes around a million rows a day, or when the daily delete starts to show in the database's I/O.

## Reading it

`audit.list` (capability `tenant:admin`; HTTP `POST /v1/audit.list`, MCP tool `audit.list`) returns the tenant's own rows newest first, a page at a time (`cursor` = the last row's id, `limit` up to 200), filtered by `from` (inclusive), `to` (exclusive), `operation`, `actorKind` and `actorId`. Platform rows of the tenant are in it too. The input hash is left out. The admin status page of #17c shows the recent actions; there is no separate audit page.

## Erasure

An erasure (ADR 019) does not delete audit rows. They hold no personal data beyond pseudonymous ids: the input is only a keyed hash, and an operator, key or supporter id that no longer leads to an address after the erasure identifies nobody. Keeping the account of who did what is the controller's accountability (GDPR article 5(2)), which is also why tenants cannot delete their own rows.
