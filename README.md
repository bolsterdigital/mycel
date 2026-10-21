# Mycel

Open-core platform for campaigning and member organisations: campaign sites, forms, one-off and recurring donations, a supporter registry and mailing, in one application you can self-host in the EU or have hosted.

Mycel is the successor to [Dreamkit](https://github.com/bolsterdigital/dreamkit) (WordPress). It keeps Dreamkit's scope and its supporter event contract, and rebuilds the rest on a framework-free TypeScript domain core with HTTP, MCP and web adapters.

**Status: architecture and scaffold.** Nothing runs yet. The decisions are in [`docs/adr/`](docs/adr/); the package map in [`docs/architecture/overview.md`](docs/architecture/overview.md). The working name may change.

## Principles

- **Accessibility and standards first**: server-rendered semantic HTML, JavaScript as enhancement, WCAG 2.2 AA gated in CI, open formats everywhere.
- **MCP first**: every operation an operator can do, an agent can do, with the same authorization.
- **Own the domain, buy the commodity**: forms, donations, supporters and mailing are Mycel's; payment processing and mail delivery are adapters.
- **One database, strict tenancy**: Postgres with Row Level Security; per-tenant export is a first-class feature.
- **EU hosting, open source**: AGPL-3.0, DCO, no CLA; data stays on owned infrastructure in the EU.

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
npm run verify      # format:check + dependency rules + typecheck + tests + build
npm run dev         # web app (once it exists)
```

Node 22, npm workspaces. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

AGPL-3.0-only. See [`LICENSE`](LICENSE), [`TRADEMARK.md`](TRADEMARK.md) and ADR 006.
