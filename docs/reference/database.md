# Database conventions

Rules for code in `packages/db` and for migrations that no single module owns. ADR 002 has the tenancy model; `packages/db/src/roles.ts` and the ratchets in `scripts/` (`db-roles`, `db-raw-sql`, `db-refusals`) enforce the rest.

## An explicit `tenant_id` filter next to RLS

Under `mycel_app` in a tenant's context, forced RLS already scopes every row; an explicit `where tenant_id = …` adds no isolation there. Write one only where it serves the index (a composite index that leads with `tenant_id`) or the policy's `WITH CHECK` (every insert names `tenant_id`), and say so in the module's opening comment, as `usage.ts` and `media.ts` do. Under a role that crosses tenants (`mycel_auth`, `mycel_worker`, `mycel_platform`, `mycel_ops`, `mycel_janitor`, `mycel_erasure`), the filter is the isolation itself and is never optional.

The 37 filters on `main` of 2026-10-29 were checked against this rule: each is either in a `mycel_app` repository, where it is redundant and harmless, or under a role that crosses tenants, where it is required. None was removed.

## Migrations

A migration is plain forward-only SQL and is never edited once it is on `main` (`schema_migrations.checksum` refuses a changed file). The header is a comment that opens with the number (`-- 0030: …`), says why the change exists with its TODO or brief, and names the rejected alternative (`Rejected: …`). Policies are named after what they allow: `tenant_isolation` for the `mycel_app` policy, `erasure_apply` for the `mycel_erasure` one.

Known exceptions, left as they are because a migration on `main` is not edited:

- 0014, 0025, 0026, 0027 and 0029 open without the number; 0001 to 0004 and 0025 to 0027 name no rejected alternative.
- 0025 names its `mycel_erasure` policy on `connection_intents` `erasure`, where 0019 and 0022 use `erasure_apply`. The name has no effect; the policy body is what counts.

## Constants

| Constant              | Value          | Where                          | Why                                                           |
| --------------------- | -------------- | ------------------------------ | ------------------------------------------------------------- |
| pool `max`            | 10 connections | `packages/db/src/index.ts`     | bounds the connections of one `createDb` pool                 |
| `db-refusals` `LIMIT` | 3              | `scripts/db-refusals.test.mjs` | refusals `packages/db` may raise, each in a listed place      |
| `db-raw-sql` `LIMIT`  | 3              | `scripts/db-raw-sql.test.mjs`  | `sql.raw` and `sql.lit` calls allowed, each in a listed place |
