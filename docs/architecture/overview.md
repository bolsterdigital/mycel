# Architecture overview

Short map; the reasoning is in [`../adr/`](../adr/).

```
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐
   fronts        │ apps/web     │  │ packages/api │  │ packages/mcp │  │  CLI     │
                 │ SvelteKit    │  │ Hono (HTTP)  │  │ MCP server   │  │ mycel    │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────┬─────┘
                        └─────────────────┴────────┬────────┴───────────────┘
                                                   ▼
                 ┌────────────────────────────────────────────────────────────┐
   domain        │ packages/core                                              │
                 │ tenants · operators · entitlements · content · theme       │
                 │ media · forms · supporters · mailing · connections         │
                 │ assist · attention · audit · jobs · ops · i18n             │
                 │ use-case registry                                          │
                 │ ports: UnitOfWork, Clock, Ids, Signer, EventBus, Scheduler,│
                 │        Mailer, BlobStore, ImageProcessor, MediaDelivery,   │
                 │        TextModel, IdentityStore, SiteDirectory, Logger,    │
                 │        ErrorReporter (repositories in each ports.ts)       │
                 └───────────────┬───────────────────────┬────────────────────┘
                                 ▼                       ▼
   adapters      ┌──────────────────────┐   ┌──────────────────────────────┐
                 │ packages/db          │   │ packages/blob (fs, S3)       │
                 │ Postgres · Kysely    │   │ packages/media-sharp         │
                 │ migrations · RLS     │   │ packages/mail-tem            │
                 │                      │   │ packages/assist-openai       │
                 └──────────────────────┘   └──────────────────────────────┘

   beside        packages/observability: logs, request context, error
                 reporting, metrics; imported by the fronts, never by core
```

**Rules of the picture** (enforced by `npm run lint:deps`):

- Arrows point down only. `core` imports nothing from the other workspaces and no I/O library.
- Fronts call use cases from `core`'s registry. They do not call adapters directly; they receive adapter instances through composition in `packages/api/src/runtime/compose.ts` (and the equivalent in `apps/web`).
- Adapters implement ports from `core`. They do not import each other.
- `packages/observability` (logs, request context, error reporting, metrics) imports only `core`; the fronts import it, `core` never does. Core code logs through `ctx.log` (the `Logger` port) and scrubs error text it stores with `scrubText` (`core/util/scrub.ts`), which the package reuses.

**Planned, not in the code.** Donations and subscriptions with a ledger and explicit state machines, and Mollie as a payment adapter ([ADR 005](../adr/005-money-ledger.md), [ADR 024](../adr/024-managed-integrations-and-external-ownership.md)); there is no payments module, payment port or payment package yet.

**Accepted extension direction, not current implementation** ([ADRs 022 to 024](extensibility.md)). A trusted operator-installed extension will declare its core/schema compatibility, owner, capabilities, render and admin contracts, locale, preview, export, fallback and migrations. Activation and browser asset loading can be scoped to a site or page, but do not isolate code executing in the host process. Core remains framework-free and exposes typed ports; untrusted backend execution stays across an authenticated external service boundary. Site-only tenants may keep an external CRM, mail platform or subscription owner through registered connections. The composition root, block registry, theme and outbox do not implement a general extension loader. Configurable forms and managed webhook/Mailchimp connections use their existing typed ports and tenant-scoped registries.

**Running it** (PR #28). One image, several entrypoints (`Dockerfile`, `docker/entrypoint.sh`); `compose.yml` runs them on one box with Postgres and Caddy, each process with only the database login ADR 011 gives it (`docs/self-hosting.md`). The `mycel` CLI (`packages/api/src/runtime/cli.ts`) is the self-hoster's front: platform functions on the owner connection, and `setup`, which creates a tenant there and then invites and adds hostnames through the registry like any front. A tag `vX.Y.Z` publishes that image to GHCR (`.github/workflows/release.yml`, cut with `npm run release`); what an upgrade may rely on is `docs/upgrading.md` (PR #29).

**One registry, many fronts.** Every use case registers with a name, an input schema, an output schema and a required capability. `packages/api` turns the registry into HTTP routes plus an OpenAPI document; `packages/mcp` turns it into MCP tools and resources; `apps/web` calls it in `+page.server.ts` actions. Adding a use case touches `core` once.

**Adding a use case** takes three steps, and the rest follows:

1. Write the function and its Zod `input` and `output` in `packages/core/src/<module>/service.ts` with `defineUseCase`: a dotted name that follows the naming rule below, a one-sentence `description`, the `requires` capability, an `effect` if it publishes, sends, exports or refunds (ADR 018 rule 5), and at least one entry in `examples`.
2. Add it to `useCases` in `packages/core/src/use-cases.ts`.
3. Run `npm run verify`. `POST /v1/<name>` (plus `GET` for a flat query), the OpenAPI operation, the MCP tool (and resource, if it declares one) and the registry conformance suites in core, api and mcp now cover it; `checkRegistry` in `registry-rules.ts` says what is missing.

**Use-case names** say what a use case works on and what it does, `<module>.<entity>.<verb>`: [use cases](../reference/use-cases.md).

**Tenant context** comes from authentication, never from a payload, and `packages/db` sets it per transaction: [database](../reference/database.md).

**Authentication** happens before a tenant is known and reads through its own role: [operators](../reference/operators.md).

**Entitlements** are a document per tenant, enforced in core: [entitlements](../reference/entitlements.md).

**Media** is a register per tenant with the bytes behind three ports: [media](../reference/media.md).

**Events.** Modules communicate through `EventBus` (a port). The first implementation is an in-process bus backed by a Postgres outbox table so that a crash never loses an event; a worker drains it. The supporter module is the main subscriber (ADR 003).

**Supporter identity and fold**: a stable id, an append-only log and a projection under a per-supporter lock: [supporters](../reference/supporters.md).

**Content** is an item, immutable revisions and a row per locale; immutable bulk plans and dry-run results follow [ADR 028](../adr/028-durable-content-bulk-plans.md), who has an item open follows [ADR 029](../adr/029-presence-and-newer-revision.md): [content model](../reference/content-model.md).

**Background work** runs in one worker process over two Postgres queues: [jobs](../reference/jobs.md).

**Observability** is one JSON object per line, without addresses: [observability](../reference/observability.md).

**Audit log**: one row per command, refused or not: [audit](../reference/audit.md).

**Stuck work** is visible and recoverable: [ops](../reference/ops.md).

**Export and erasure**: a tenant leaves as an archive of its rows and its media: [export and erasure](../reference/export.md).

**External effects** get an intent row first (ADR 019 rule 6): [jobs](../reference/jobs.md).

**Where things live**

| Path                             | Contents                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/<module>/`    | `model.ts` (types, schemas), `service.ts` (use cases), `ports.ts`, `events.ts`, tests                                                |
| `packages/core/src/use-cases.ts` | every use case; fronts call `buildRegistry()`, the class is in `registry.ts`                                                         |
| `packages/db/migrations/`        | plain SQL, forward-only, one file per change, RLS policy next to the table                                                           |
| `packages/api/src/`              | Hono app, composition root, API-key authentication, route generation, OpenAPI                                                        |
| `packages/mcp/src/`              | MCP server over stdio (one API key per process), tool/resource generation                                                            |
| `packages/observability/src/`    | JSON logger with redaction, request context, error reporters, Prometheus registry                                                    |
| `apps/web/src/routes/(public)/`  | tenant sites, rendered from blocks                                                                                                   |
| `apps/web/src/routes/(admin)/`   | operator admin behind OIDC, on the platform origin only (ADR 014 rule 4)                                                             |
| `docs/reference/`                | one page per module or contract, listed below                                                                                        |
| `docs/adr/`                      | decisions, indexed in [`docs/adr/README.md`](../adr/README.md); `docs/plans` is a gitignored symlink to the private planning sibling |

**Reference pages.** Use cases: [names](../reference/use-cases.md). Tenancy and access: [hostnames](../reference/hostnames.md), [operators](../reference/operators.md), [entitlements](../reference/entitlements.md), [platform API](../reference/platform-api.md), [database](../reference/database.md). Content: [content model](../reference/content-model.md), [blocks](../reference/blocks.md), [theme](../reference/theme.md), [fonts](../reference/fonts.md), [media](../reference/media.md), [i18n](../reference/i18n.md), [assist](../reference/assist.md). Supporters and mail: [forms](../reference/forms.md), [supporters](../reference/supporters.md), [mail](../reference/mail.md), [connections](../reference/connections.md), [managed webhooks](../reference/managed-webhooks.md), [export and erasure](../reference/export.md). Running it: [jobs](../reference/jobs.md), [ops](../reference/ops.md), [observability](../reference/observability.md), [audit](../reference/audit.md). Frontend quality: [runner](../reference/frontend-quality-runner.md), [enforcement](../reference/frontend-quality-enforcement.md).
