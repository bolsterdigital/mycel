# ADR 002 - One Postgres, `tenant_id` on every row, Row Level Security

- **Status**: accepted
- **Date**: 2026-10-21
- **Amended**: 2026-10-21 for TODO #7 (rule 3: operator sessions; rule 4: identity tables)
- **Rule 6 scope refined**: 2026-10-24 by [ADR 024](024-managed-integrations-and-external-ownership.md). Mycel's own storage remains in the EU; an explicitly tenant-authorized connector may export to a named external destination.

## Context

Dreamkit runs one WordPress install per client. Isolation is excellent; everything else is expensive: every platform feature ships n times, every upgrade is n deploys, and fleet-wide questions ("which sites still use X") need tooling. Mycel is one application serving many organisations (tenants). The tenancy model is the single most expensive thing to change later, so it is decided now.

## Decision

1. **One Postgres database, one schema, one deployment serves all tenants.** Every tenant-owned table carries a `tenant_id uuid not null` column with a foreign key to `tenants`.
2. **Row Level Security is enabled and forced on every tenant-owned table.** Policies compare `tenant_id` with `current_setting('app.tenant_id', true)::uuid`. The application connects with a role that is _not_ the table owner and cannot bypass RLS.
3. **Tenant context is set per transaction, derived from authentication, never from the payload.** An API key, a session or an MCP connection is scoped to exactly one tenant; `packages/db` sets `app.tenant_id` with `set_config(..., true)` at the start of every transaction. A request that carries a `tenant_id` in its body is a bug. An operator's browser session identifies the operator, not a tenant: the tenant of an admin request follows from the admin URL (ADR 014 rule 4) and the operator's membership of that tenant, and the resulting `Principal` is scoped to that one tenant.
4. **Platform operations (create tenant, list tenants, migrations) use a separate operator role and separate code paths**, kept out of tenant-facing adapters. The identity tables (`operators`, `tenant_memberships`, `api_keys`) are read, and `operators` written, at authentication time, before a tenant context exists, through the dedicated `mycel_auth` role (ADR 011 rule 1); the application role sees memberships and keys only under its tenant context.
5. **Per-tenant export is a first-class use case** from the start: a tenant's complete data (supporters, events, consents, content, donations ledger, mailing lists) exports to a documented JSON format with one command. Portability is how we keep the "one database" choice honest.
6. **Tenant data lives in the EU**: Hetzner (Falkenstein/Nuremberg) or Scaleway, with object storage likewise.

## Rejected alternatives

- **Database (or schema) per tenant**: stronger blast-radius isolation and trivial per-tenant backup, but migrations and connection pooling scale badly, cross-tenant platform features need a federation layer, and the operational burden is the one we already know from the WordPress fleet. Kept as a fallback for a hypothetical large client that contractually needs it; ADR 001's repository port is the seam.
- **Application-level filtering only, no RLS**: one forgotten `where tenant_id = ?` leaks another organisation's supporters. RLS makes that class of bug structurally impossible at the cost of one `set_config` per transaction.
- **Managed cloud database (Neon, Supabase, RDS)**: convenient, but puts the most sensitive data (supporters, donations) outside owned infrastructure and often outside the EU. Postgres on our own box with managed backups (restic to Hetzner Storage Box) is the tech-principles answer.

## Consequences

- Every migration creating a tenant-owned table also creates its RLS policy; a test asserts that every such table has `rowsecurity = true` and `forcerowsecurity = true`.
- The `db` adapter exposes `withTenant(tenantId, fn)` and nothing else for tenant-scoped work.
- Identifiers are UUIDv7 (time-ordered) so that export, import and merge of tenants never collide.
