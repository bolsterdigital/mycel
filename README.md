# Mycel

Open-core platform for campaigning and member organisations: campaign sites, forms, one-off and recurring donations, a supporter registry and mailing, in one application you can self-host in the EU or have hosted.

Mycel is the successor to [Dreamkit](https://github.com/bolsterdigital/dreamkit) (WordPress). It keeps Dreamkit's scope and its supporter event contract, and rebuilds the rest on a framework-free TypeScript domain core with HTTP, MCP and web adapters.

**Status: early.** A first vertical slice runs (a signup form through every layer). The decisions are in [`docs/adr/`](docs/adr/); the package map in [`docs/architecture/overview.md`](docs/architecture/overview.md). The working name may change.

## Principles

- **Accessibility and standards first**: server-rendered semantic HTML, JavaScript as enhancement, WCAG 2.2 AA gated in CI, open formats everywhere.
- **MCP first**: every operation an operator can do, an agent can do, with the same authorization.
- **Own the domain, buy the commodity**: Mycel offers forms, donations, supporters and mailing; payment processing and mail delivery are adapters. A tenant may instead keep a named external CRM, mail or subscription owner through a managed connection ([ADRs 023 and 024](docs/architecture/extensibility.md)).
- **One database, strict tenancy**: Postgres with Row Level Security; per-tenant export is a first-class feature.
- **EU hosting, open source**: AGPL-3.0, DCO, no CLA; Mycel's own storage and default processors stay in the EU. A tenant may explicitly authorize an external destination for its own data ([ADR 024](docs/adr/024-managed-integrations-and-external-ownership.md)).

The accepted contracts for managed extensions, configurable forms and external integrations are in [extensibility and external ownership](docs/architecture/extensibility.md). They describe direction, not features already delivered in this early build.

## Layout

```
packages/core   domain: entities, use cases, ports, schemas, i18n   (no I/O)
packages/db     Postgres adapter: Kysely, SQL migrations, RLS
packages/api    Hono HTTP API + OpenAPI, generated from the use-case registry
packages/mcp    MCP server, generated from the same registry
apps/web        SvelteKit: public tenant sites + operator admin
docs/adr        decisions (read first)
```

## Development

```sh
npm install
cp .env.example .env
npm run db:up       # Postgres in Docker
npm run db:seed     # migrations + tenant `probe` with a signup page and a demo page and article
npm run dev         # API on :8787, web on :5173 -> http://localhost:5173/probe/signup
```

Node 22, npm workspaces. `npm run verify` is the gate. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Self-hosting

One image, one `compose.yml`: Postgres, the API, the web app, a worker and Caddy with automatic certificates on a single server. [`docs/self-hosting.md`](docs/self-hosting.md) goes from an empty server to the first login; `mycel setup` creates the first site and its operator. Agents connect through the MCP server over stdio (`docker compose run --rm -T worker mcp`, acting with one site's API key); remote MCP over HTTP is planned.

## Licence

AGPL-3.0-only. See [`LICENSE`](LICENSE), [`TRADEMARK.md`](TRADEMARK.md) and ADR 006.
