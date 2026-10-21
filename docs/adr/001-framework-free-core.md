# ADR 001 - The domain core is framework-free; everything else is an adapter

- **Status**: accepted
- **Date**: 2026-10-21

## Context

Mycel replaces a WordPress platform (Dreamkit) whose domain logic lives inside plugins of plugins: forms in Gravity Forms, recurring donations in Pronamic, mailing in Listmonk. Every one of those choices became permanent because the domain was expressed in the vendor's model. The one thing this project must not repeat is letting a framework or a vendor own the domain.

At the same time, we do want to use frameworks (SvelteKit for the web app, Hono for HTTP, the MCP SDK for agents) and we want to be able to replace them when something better comes along, without a rewrite.

## Decision

1. **`packages/core` holds the domain and depends on nothing that knows about HTTP, databases, frameworks or vendors.** It contains the entities, value objects, invariants, use cases (services) and the _ports_ those use cases need: a repository port, a clock, an id generator, a mail-sending port, a payment-provider port, an event-publishing port. Schemas are expressed with a Standard Schema compatible library (currently Zod) so validators are portable.
2. **Everything that touches the outside world is an adapter package** implementing one or more ports: `packages/db` (Postgres via Kysely), `packages/api` (Hono HTTP), `packages/mcp` (MCP server), `apps/web` (SvelteKit admin and public rendering), later `packages/payments-mollie`, `packages/mail-tem`, a CLI.
3. **One service layer, many fronts.** The HTTP API, the MCP server, the admin UI and the CLI all call the same use cases in `core`. No front has logic the others lack. "MCP-first" is this rule applied: if an operation exists, it exists for agents too, with the same authorization.
4. **Dependency direction is enforced mechanically** (`npm run lint:deps`): `core` imports no other workspace and no I/O library; adapters import `core`; adapters do not import each other except through `core` ports. A violation fails `verify`.
5. **The core is the only place where business rules live.** Database constraints and RLS (ADR 002) are a second line of defence, never the first expression of a rule.

## Rejected alternatives

- **Build directly inside SvelteKit (`src/lib/server`)**: fastest start, but the domain ends up importing `$app/*` and `$env/*` within weeks, and the MCP server then has to re-implement or wrap it. This is exactly the lock-in we are escaping.
- **Payload CMS or another headless CMS as the base**: admin, auth, media and i18n for free, but the domain would be shaped by its collection model and plugin API, and the project would inherit its Next.js dependency. Acceptable for a prototype, not for the thing we intend to maintain for a decade.
- **Microservices per domain**: the registry already exists as a separate service (`dreamkit-supporter-registry`) and the experience is that cross-service consistency (supporter ↔ donation ↔ consent) is the hard part. A modular monolith with package boundaries gives the same separation without the network.

## Consequences

- Slightly more ceremony per feature: a port, a use case, an adapter. In exchange, every feature is testable without a database and callable from every front.
- The web app is replaceable. So is Hono. So is Kysely. The core is not, and that is the point.
- `packages/core` ships with its own test suite using in-memory ports; integration tests live with the adapters.
