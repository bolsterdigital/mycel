# Changelog

All notable changes to Mycel. Each line is the title of a merged pull request (a conventional commit, see [CONTRIBUTING.md](CONTRIBUTING.md)); `npm run release` writes the sections, and `## Unreleased` is a preview it replaces. Upgrading between versions: [docs/upgrading.md](docs/upgrading.md). Versions before 1.0 may break in a minor release; the changelog says so under "Breaking changes".

## Unreleased

## 0.1.0 - 2026-10-22

### Features

- **release:** GHCR image, changelog and upgrade promise (TODO #18b) ([#29](https://github.com/bolsterdigital/mycel/pull/29))
- **ops:** production compose, mycel setup and Caddy proof (TODO #18a) ([#28](https://github.com/bolsterdigital/mycel/pull/28))
- **content:** block set, media references and theme contract (TODO #8b2) ([#25](https://github.com/bolsterdigital/mycel/pull/25))
- HTTP boundaries and CI gates ([#24](https://github.com/bolsterdigital/mycel/pull/24))
- **db:** database boundaries of the fronts enforced (TODO #20b) ([#23](https://github.com/bolsterdigital/mycel/pull/23))
- **content:** block operations by id, content.item.find, content_block_refs (TODO #8b1) ([#21](https://github.com/bolsterdigital/mycel/pull/21))
- stuck work visible, tenant and hoster recovery, ops view (TODO #17c) ([#20](https://github.com/bolsterdigital/mycel/pull/20))
- **content:** items, revisions and publication per locale (TODO #8a) ([#14](https://github.com/bolsterdigital/mycel/pull/14))
- audit log for every command (TODO #17b) ([#19](https://github.com/bolsterdigital/mycel/pull/19))
- structured logs, error reporting, readiness, metrics, job retention (TODO #17a) ([#18](https://github.com/bolsterdigital/mycel/pull/18))
- **mailing:** exclusive claim and counted reconciliation (#22C) ([#17](https://github.com/bolsterdigital/mycel/pull/17))
- **web:** media admin, upload/list/edit/delete without JS (TODO #10b) ([#16](https://github.com/bolsterdigital/mycel/pull/16))
- media register, BlobStore, variants and delivery route (TODO #10a) ([#15](https://github.com/bolsterdigital/mycel/pull/15))
- entitlements, usage read model and platform API (TODO #16) ([#12](https://github.com/bolsterdigital/mycel/pull/12))

### Fixes

- **operators:** make keys and member changes under the membership lock (TODO #20a) ([#22](https://github.com/bolsterdigital/mycel/pull/22))
- **core:** validate output before committing the unit of work ([#11](https://github.com/bolsterdigital/mycel/pull/11))

### Documentation

- accept editor and stable block operations contract ([#13](https://github.com/bolsterdigital/mycel/pull/13))
- handoff per lane (mbp, dev) with domains in docs/plans/lanes.md ([#10](https://github.com/bolsterdigital/mycel/pull/10))

### Other

- **db:** drain only the suite's own tenants (TODO #26) ([#26](https://github.com/bolsterdigital/mycel/pull/26))
- Jobs table and scheduler (TODO #15) ([#9](https://github.com/bolsterdigital/mycel/pull/9))
- Hostnames and custom domains (TODO #14) ([#8](https://github.com/bolsterdigital/mycel/pull/8))
- ADR 011 and 014: tenant_hostnames is tenant data under RLS, resolved through mycel_auth (brief #14)
- Operator-auth: OIDC, API-keys, tenant-membership (TODO #7) ([#7](https://github.com/bolsterdigital/mycel/pull/7))
- ADR 002 and 011: operator sessions and the identity tables behind mycel_auth (TODO #7)
- Double opt-in as a fact, mail intent rows, janitor role (TODO #13b) ([#6](https://github.com/bolsterdigital/mycel/pull/6))
- Supporter identity, fold and monthly event partitions (TODO #13a) ([#5](https://github.com/bolsterdigital/mycel/pull/5))
- ADR 003: events partitioned by month, tenant sub-partitioning deferred
- Registry to HTTP, OpenAPI and MCP with registry conformance (TODO #3) ([#4](https://github.com/bolsterdigital/mycel/pull/4))
- Configurable dev Postgres port, explicit install-script policy ([#3](https://github.com/bolsterdigital/mycel/pull/3))
- RLS conformance test and dev ergonomics (TODO #2, #6) ([#2](https://github.com/bolsterdigital/mycel/pull/2))
- ADR 017-019 after second-opinion review: tenant is one site, precise editorial operations, supporter consistency
- Ignore harness worktrees under .claude/
- ADR 012-016: content types, customisation ladder, hostnames, entitlements, readers and paywall; testing strategy
- ADR 011: background roles and the outbox as the only event transport
- Vertical probe: signup form end-to-end ([#1](https://github.com/bolsterdigital/mycel/pull/1))
- Scaffold Mycel: ADR 000-010, monorepo skeleton, verify gate
