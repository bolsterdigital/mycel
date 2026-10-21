# ADR 008 - Current stack picks and the policy for accepting dependencies

- **Status**: accepted
- **Date**: 2026-10-21

## Context

With coding agents, writing code is cheap and _owning a dependency_ is not: every one carries upgrades, CVEs, licence terms and a roadmap we do not control. The build-versus-buy line therefore moves towards building the domain and buying only commodity with liability. ADR 001 makes the framework picks replaceable; this ADR records what they are today and how they may change.

## Decision

### Current picks (replaceable, not frozen)

| Concern             | Pick                                                                                               | Why this one                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Language, runtime   | TypeScript strict, Node 22 LTS, ESM                                                                | One language across core, adapters and web; agents are strongest here        |
| Package manager     | npm workspaces                                                                                     | Boring, no extra tool; monorepo of a handful of packages                     |
| Schema / validation | Zod (Standard Schema)                                                                              | Portable validators; swap-able for Valibot via the Standard Schema interface |
| Database            | PostgreSQL 16+, Kysely, `pg`, SQL migrations                                                       | Typed query builder without an ORM's hidden behaviour; RLS needs real SQL    |
| HTTP                | Hono                                                                                               | Small, standards-based (Web Request/Response), runs anywhere                 |
| Agents              | `@modelcontextprotocol/sdk`                                                                        | The MCP reference implementation                                             |
| Web                 | SvelteKit 2, Svelte 5 runes, `adapter-node`                                                        | SSR-first HTML, house style, no React/Next lock-in                           |
| CSS                 | Layered vanilla CSS with design tokens for public rendering; Tailwind v4 allowed in the admin only | Public sites need tokens-as-data (ADR 004); admin wants velocity             |
| Auth (operators)    | Any OIDC provider; Zitadel at `auth.dreamkit.eu` in hosting                                        | No app is an auth hub; PKCE, own callback per app                            |
| Payments            | Mollie behind a port (ADR 005)                                                                     | EU PSP with SEPA recurring                                                   |
| Mail delivery       | Scaleway TEM or any SMTP behind a port                                                             | EU provider; delivery is bought, mailing logic is built (ADR 010)            |
| Object storage      | S3-compatible (Hetzner / Scaleway) behind a port                                                   | Commodity                                                                    |
| Analytics           | Plausible, self-hosted                                                                             | House style; privacy without consent banners                                 |
| Tests               | Vitest; Playwright with axe for the web app                                                        | Standard                                                                     |
| Hosting             | Docker image, Coolify on Hetzner; Caddy; Postgres on the box with restic backups                   | tech-principles ladder: owned EU infra                                       |

### What we do not take on

- WordPress, PHP, Gravity Forms, Pronamic, or any plugin ecosystem as a dependency of the core.
- ORMs with a query engine of their own (Prisma), Next.js or Vercel-specific tooling, React in the core web app.
- Redis, Kafka, RabbitMQ or any second datastore before Postgres provably cannot do the job (queues and events start as Postgres tables with `SKIP LOCKED`).
- Kubernetes, serverless platforms, managed cloud databases, US-hosted SaaS in the data path (Auth0, Stripe as primary, Mailchimp, Sentry Cloud).
- Any build or deploy step that only works on a service we do not run.
- Licences incompatible with AGPL-3.0 (ADR 006).

### Policy for adding a dependency

1. Ask first whether 200 lines of our own code cover it. If yes, write them.
2. Otherwise it must be: open source under a compatible licence, actively maintained, with a plausible exit (we could vendor or replace it within a week).
3. Anything that touches money, identity or mail delivery goes behind a port in `packages/core` so that it is an adapter, never a dependency of the domain.
4. Record the "why" at the top of the config file or module that introduces it, including the rejected alternative.

### Policy for changing a pick

Replacing a framework or library in the table is a brief plus a PR, not an ADR, as long as ADR 001's boundaries hold. Changing a boundary (what the core may depend on) is a new ADR.

## Rejected alternatives

- **Bun or Deno** as runtime: attractive, but Node LTS is what every adapter, the MCP SDK and the hosting stack are tested against.
- **pnpm or Turborepo**: better at scale; this monorepo has five packages and npm workspaces suffice. Revisit if install time or caching becomes a measured problem.
- **Drizzle**: comparable to Kysely; Kysely wins on being "just typed SQL" with no schema DSL, which matters for RLS and partitioning.

## Consequences

- `scripts/check-dependency-rules.mjs` enforces import direction and licence allow-list in `verify`.
- `renovate`/dependabot runs weekly; a dependency that goes unmaintained for a year is a TODO item to replace or vendor.
