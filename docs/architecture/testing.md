# Testing strategy

Tests exist to let agents change this codebase without a human re-reading every line. The strategy is therefore: **a few generic conformance suites that grow by themselves** whenever a registry gains an entry, plus a small number of hand-written tests where the domain has real invariants. Per-feature test files that restate the implementation are discouraged.

## Layers

| Layer                | Where                                                                            | Grows how                                                                                                                                                                                                                                                                                                                                          | Needs                    |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Core unit            | `packages/core/src/<module>/*.test.ts`                                           | Hand-written. Per use case: the happy path and one test per invariant or typed error. State machines (ledger, subscription, content status) get property tests with `fast-check`.                                                                                                                                                                  | nothing, in-memory ports |
| Registry conformance | `packages/core/src/registry.conformance.test.ts`, `packages/api`, `packages/mcp` | Automatic. For every use case: name pattern, description present, input and output convert to JSON Schema, HTTP route exists and rejects a principal without the capability (403) and a malformed body (400 Problem Details), MCP tool list equals the registry, OpenAPI document validates, a use case that consumes a limit (ADR 015) checks it. | nothing                  |
| Block conformance    | `apps/web/src/lib/blocks/blocks.conformance.test.ts` + Playwright                | Automatic. Every block type exports `examples` (one per variant, in two locales). Each example: validates, renders to HTML, Markdown and (later) e-mail, heading level follows depth, axe is clean, restricted content never leaks to an anonymous principal, snapshot of the HTML.                                                                | Chromium                 |
| Database conformance | `packages/db/src/*.conformance.test.ts`                                          | Automatic. Migrations apply from empty; every table with `tenant_id` has RLS enabled, forced and a `tenant_isolation` policy; every `using (true)` policy is bound to a named worker role; `mycel_app` without `set_config` reads nothing; every repository round-trips a fixture.                                                                 | Postgres                 |
| Adapter contract     | `packages/<adapter>/src/*.test.ts`                                               | Hand-written, from recorded provider payloads (Mollie, TEM) kept as fixtures. One test per webhook shape and per state transition the adapter must map.                                                                                                                                                                                            | nothing                  |
| End-to-end flows     | `apps/web/e2e/*.spec.ts`                                                         | Hand-written, budgeted: at most one spec per flow where money, consent or access changes hands (signup with double opt-in, donate, member sign-in, publish). Target: ten specs, not a hundred.                                                                                                                                                     | Postgres, Chromium       |

## Rules

1. **Fixtures live with the thing they describe.** A block module exports `examples`; a use case module exports `fixtures`; a migration that adds a tenant-owned table needs no test, the conformance suite finds it. A registry entry without a fixture fails `verify`.
2. **One gate, `npm run verify`,** and it must stay under ten minutes on CI. When it does not, split by layer into parallel jobs before trimming tests.
3. **Skip or fail, never silently pass.** Suites that need Postgres or Chromium skip locally when the dependency is absent and fail in CI (`E2E_REQUIRED=1`).
4. **No mocks of our own modules.** Ports have in-memory implementations in `packages/core/src/testing`; use those. Mock only the outside world, from recorded payloads.
5. **Snapshots are reviewed, not regenerated.** A PR that updates an HTML snapshot says why in the description.
6. **Flaky tests are fixed or deleted the same day**; a quarantine list longer than zero is a drift signal for `merge-housekeeping`.
7. **No coverage percentage gate and no mutation testing.** Coverage is reported for information; the conformance suites are the guarantee.
8. **Accessibility has a manual layer too**: a screen-reader pass per release on the public flows, recorded in the release notes. Axe is a floor, not a ceiling.
9. **Performance budget** (ADR 009 rule 4) is a Playwright assertion on the public page: no client JavaScript beyond the enhancement bundle, fonts self-hosted, images sized.

## What a PR needs

The PR description names the conformance suite that grew (or says why none did), the hand-written invariants added, and what could not be run locally. Review reads the fixtures first: if the examples are right, the generic suites have already read the rest.
