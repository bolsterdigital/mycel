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

**Tenant context** is set by the front from authentication and passed into `core` as a `Principal` (tenant, actor, capabilities). `packages/db` turns it into `set_config('app.tenant_id', ...)` per transaction; RLS does the rest (ADR 002).

**Events.** Modules communicate through `EventBus` (a port). The first implementation is an in-process bus backed by a Postgres outbox table so that a crash never loses an event; a worker drains it. The supporter module is the main subscriber (ADR 003).

**Where things live**

| Path                            | Contents                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/src/<module>/`   | `model.ts` (types, schemas), `service.ts` (use cases), `ports.ts`, `events.ts`, tests |
| `packages/core/src/registry.ts` | the use-case registry every front reads                                               |
| `packages/db/migrations/`       | plain SQL, forward-only, one file per change, RLS policy next to the table            |
| `packages/api/src/`             | Hono app, auth middleware (API keys, OIDC bearer), route generation, OpenAPI          |
| `packages/mcp/src/`             | MCP server over stdio and Streamable HTTP, tool/resource generation                   |
| `apps/web/src/routes/(public)/` | tenant sites, rendered from blocks                                                    |
| `apps/web/src/routes/(admin)/`  | operator UI behind OIDC                                                               |
| `docs/adr/`                     | decisions; `docs/plans`                                                               | private planning sibling (symlink) |
