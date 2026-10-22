# Architecture overview

Short map; the reasoning is in [`../adr/`](../adr/).

```
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐
   fronts        │ apps/web     │  │ packages/api │  │ packages/mcp │  │  CLI     │
                 │ SvelteKit    │  │ Hono (HTTP)  │  │ MCP server   │  │ (later)  │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────┬─────┘
                        └─────────────────┴────────┬────────┴───────────────┘
                                                   ▼
                 ┌────────────────────────────────────────────────────────────┐
   domain        │ packages/core                                              │
                 │ tenants · content (blocks) · forms · supporters (events)   │
                 │ donations (ledger) · mailing · i18n · use-case registry    │
                 │ ports: Repository, Clock, Ids, PaymentProvider, Mailer,    │
                 │        EventBus, BlobStore                                 │
                 └───────────────┬───────────────────────┬────────────────────┘
                                 ▼                       ▼
   adapters      ┌──────────────────────┐   ┌──────────────────────────────┐
                 │ packages/db          │   │ packages/payments-mollie     │
                 │ Postgres · Kysely    │   │ packages/mail-tem   (later)  │
                 │ migrations · RLS     │   │ packages/blob-s3    (later)  │
                 └──────────────────────┘   └──────────────────────────────┘
```

**Rules of the picture** (enforced by `npm run lint:deps`):

- Arrows point down only. `core` imports nothing from the other workspaces and no I/O library.
- Fronts call use cases from `core`'s registry. They do not call adapters directly; they receive adapter instances through composition in `packages/api/src/compose.ts` (and the equivalent in `apps/web`).
- Adapters implement ports from `core`. They do not import each other.

**One registry, many fronts.** Every use case registers with a name, an input schema, an output schema and a required capability. `packages/api` turns the registry into HTTP routes plus an OpenAPI document; `packages/mcp` turns it into MCP tools and resources; `apps/web` calls it in `+page.server.ts` actions. Adding a use case touches `core` once.

**Adding a use case** takes three steps, and the rest follows:

1. Write the function and its Zod `input` and `output` in `packages/core/src/<module>/service.ts` with `defineUseCase`: a dotted name, a one-sentence `description`, the `requires` capability, an `effect` if it publishes, sends, exports or refunds (ADR 018 rule 5), and at least one entry in `examples`.
2. Add it to `useCases` in `packages/core/src/use-cases.ts`.
3. Run `npm run verify`. `POST /v1/<name>` (plus `GET` for a flat query), the OpenAPI operation, the MCP tool (and resource, if it declares one) and the registry conformance suites in core, api and mcp now cover it; `checkRegistry` in `registry-rules.ts` says what is missing.

**Tenant context** is set by the front from authentication and passed into `core` as a `Principal` (tenant, actor, capabilities). `packages/db` turns it into `set_config('app.tenant_id', ...)` per transaction; RLS does the rest (ADR 002).

**Authentication** happens before a tenant is known, so it reads through its own role. `IdentityStore` (a core port, `createIdentityStore` in `packages/db`) runs each lookup in a transaction that does `set local role mycel_auth`, the one role that may read memberships and API keys across tenants and write logged-in operators (ADR 011 rule 1, migration 0007). The fronts reach it through the `mycel_authenticator` login (`AUTH_DATABASE_URL`), which has no rights except entering that role; web and API never use the schema owner for it. `core/operators/authenticate.ts` turns the answers into principals: an API key (`Authorization: Bearer`, HTTP) or the same key acting as an MCP agent session gets exactly the key's capabilities, looked up on every request so revocation is immediate; an operator in the web admin gets the capabilities of their membership of the tenant in the `/admin/{tenant}` URL, read per request. The operator's browser session is a signed, stateless cookie (`core/operators/session.ts`, 12 hours, `Path=/admin`) that names the operator and nothing else. Login is OIDC (authorization code with PKCE, `openid-client` in `apps/web/src/lib/server/oidc.ts`); development and the e2e gate use `scripts/mock-oidc.mjs`. Managing members and keys is ordinary use cases (`tenant.members.*`, `tenant.keys.*`, all `tenant:admin`) running as `mycel_app` under RLS.

**Events.** Modules communicate through `EventBus` (a port). The first implementation is an in-process bus backed by a Postgres outbox table so that a crash never loses an event; a worker drains it. The supporter module is the main subscriber (ADR 003).

**Supporter identity and fold.** Ingest locks the event's e-mail address (a transaction-scoped advisory lock per tenant and address), resolves it to a stable `supporter_id` (a new UUIDv7 on first sight), appends the event to the monthly partitioned `events` log (dedup on the deterministic id) and folds it into the `supporters` projection. The projection records `appliedThrough`, the fold position (`occurred_at`, then id) of the last event it applied: a newer event is applied on top, a late one triggers a re-fold of that one supporter from its log, so every arrival order ends in the same projection. An address changes only through `supporters.email.change`, which locks both addresses and logs `supporter.email_changed` (ADR 019 rules 1 to 3). Monthly partitions are created by `migrate` up to three months ahead; a backfill calls `ensureEventPartitions` for its own range first.

**External effects get an intent row first** (ADR 019 rule 6). A subscriber that calls a provider writes `mail_sends` (key `<subscriber>:<event id>`, `attempted_at`) in its own committed transaction before the call, records `sent_at` and the provider id after it, and on redelivery reconciles an attempted-but-unknown intent with the provider (`Mailer.wasSent`) before it ever sends again; `unknown` throws so the outbox backs off. `sendOnce` in `packages/core/src/mailing/confirmation.ts` is the one implementation of that protocol.

**Where things live**

| Path                            | Contents                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/src/<module>/`   | `model.ts` (types, schemas), `service.ts` (use cases), `ports.ts`, `events.ts`, tests |
| `packages/core/src/registry.ts` | the use-case registry every front reads                                               |
| `packages/db/migrations/`       | plain SQL, forward-only, one file per change, RLS policy next to the table            |
| `packages/api/src/`             | Hono app, composition root, API-key authentication, route generation, OpenAPI         |
| `packages/mcp/src/`             | MCP server over stdio (one API key per process), tool/resource generation             |
| `apps/web/src/routes/(public)/` | tenant sites, rendered from blocks                                                    |
| `apps/web/src/routes/(admin)/`  | operator admin behind OIDC, on the platform origin only (ADR 014 rule 4)              |
| `docs/adr/`                     | decisions; `docs/plans`                                                               | private planning sibling (symlink) |
