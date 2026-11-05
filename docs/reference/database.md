# Database conventions

Rules for code in `packages/db` and for migrations that no single module owns. ADR 002 has the tenancy model; `packages/db/src/infra/roles.ts` and the ratchets in `scripts/` (`db-roles`, `db-raw-sql`, `db-refusals`) enforce the rest.

## Tenant context

**Tenant context** is set by the front from authentication and passed into `core` as a `Principal` (tenant, actor, capabilities). `packages/db` turns it into `set_config('app.tenant_id', ...)` per transaction, as `mycel_app` (every `tenant_isolation` policy is bound to that role since migration 0018, so even the schema owner does tenant work only by entering it); RLS does the rest (ADR 002). For a public page the tenant is the site being visited: `apps/web/src/hooks.server.ts` resolves the `Host` header through `SiteDirectory` (a core port; `createSiteDirectory` in `packages/db` reads `tenant_hostnames` as `mycel_auth`, cached per hostname for thirty seconds) and puts the site on `locals.site`; a non-primary hostname is a 301 to the primary, an unverified custom hostname a 404, and on a development host the first path segment names the tenant (ADR 014, `docs/reference/hostnames.md`). The universal `reroute` hook puts the slug in front of the path internally so one set of `(public)/[tenant]/...` handlers serves both forms. `mycel_app` reads tenants through the `tenant_directory` view (id, slug, name, default locale, locales), never the table. Absolute site URLs come from `siteUrl` in `core/tenants/url.ts` and nowhere else. A public page is rendered by `apps/web/src/lib/blocks/`: one resolver fetches every reference of the published projection (media, forms, linked items) into a plain render model, and the components and the Markdown renderer are pure functions of that model; the theme is a hashed stylesheet route (`docs/reference/theme.md`). Content paths follow one grammar (`/<slug>`, `/articles/<slug>`, a `/<locale>` prefix for every locale but the site's default; `apps/web/src/lib/server/public/content-route.ts`), carry canonical and `hreflang` links, and are publicly cacheable with a strong ETag that `hooks.server.ts` turns into a 304 (`lib/server/http/http-cache.ts`).

## An explicit `tenant_id` filter next to RLS

Under `mycel_app` in a tenant's context, forced RLS already scopes every row; an explicit `where tenant_id = …` adds no isolation there. Write one only where it serves the index (a composite index that leads with `tenant_id`) or the policy's `WITH CHECK` (every insert names `tenant_id`), and say so in the module's opening comment, as `usage.ts` and `media.ts` do. Under a role that crosses tenants (`mycel_auth`, `mycel_worker`, `mycel_platform`, `mycel_ops`, `mycel_janitor`, `mycel_erasure`), the filter is the isolation itself and is never optional.

The 37 filters on `main` of 2026-10-29 were checked against this rule: each is either in a `mycel_app` repository, where it is redundant and harmless, or under a role that crosses tenants, where it is required. None was removed.

## Migrations

A migration is plain forward-only SQL and is never edited once it is on `main` (`schema_migrations.checksum` refuses a changed file). The header is a comment that opens with the number (`-- 0030: …`), says why the change exists with its TODO or brief, and names the rejected alternative (`Rejected: …`). Policies are named after what they allow: `tenant_isolation` for the `mycel_app` policy, `erasure_apply` for the `mycel_erasure` one.

Known exceptions, left as they are because a migration on `main` is not edited:

- 0014, 0025, 0026, 0027 and 0029 open without the number; 0001 to 0004 and 0025 to 0027 name no rejected alternative.
- 0025 names its `mycel_erasure` policy on `connection_intents` `erasure`, where 0019 and 0022 use `erasure_apply`. The name has no effect; the policy body is what counts.

## Collation

An order a person reads (the titles of a content list) names its collation in the query: `collate "und-x-icu"`, the Unicode root collation, which the in-memory adapter matches with `Intl.Collator('und')`. The database's own default collation differs per installation (glibc, musl and ICU order a space, a capital and an accent differently), so an order left to it would differ between two boxes and from the tests. This needs a Postgres built with ICU, which the pinned image and the common distribution packages are. An order nobody reads (ids, timestamps) keeps the column's own collation, `"C"` where a migration set it.

## Constants

| Constant              | Value          | Where                                | Why                                                           |
| --------------------- | -------------- | ------------------------------------ | ------------------------------------------------------------- |
| pool `max`            | 10 connections | `packages/db/src/index.ts`           | bounds the connections of one `createDb` pool                 |
| `db-refusals` `LIMIT` | 3              | `scripts/gates/db-refusals.test.mjs` | refusals `packages/db` may raise, each in a listed place      |
| `db-raw-sql` `LIMIT`  | 3              | `scripts/gates/db-raw-sql.test.mjs`  | `sql.raw` and `sql.lit` calls allowed, each in a listed place |
