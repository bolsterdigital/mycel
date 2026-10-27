# ADR 014 - Tenants are resolved from the hostname; custom domains are tenant data

- **Status**: accepted
- **Date**: 2026-10-21
- **Amended**: 2026-10-21 by ADR 017 (a tenant is one site; no `site` entity below it); 2026-10-22 for PR #8 (consequences: `tenant_hostnames` is tenant data under RLS, written by the tenant's own use cases; resolution reads through `mycel_auth`)
- **Builds on**: ADR 002 rule 3 (tenant context from authentication or, for public pages, from the site being visited)

## Context

The probe addresses a site as `/{tenant}/{slug}`. A real site lives on its own domain (`afvalovennee.nl`), and until it does, on a platform subdomain. How a request maps to a tenant shapes URLs, cookies, caching, TLS, e-mail links and the read route, so it is decided before fase 1.

## Decision

1. **The public site of a tenant is resolved from the `Host` header.** A tenant has one or more hostnames (`tenant_hostnames`: hostname, tenant_id, `primary` flag, `verified_at`, `kind: platform | custom`). Exactly one is primary; the others redirect (301) to it.
2. **Every tenant gets a platform hostname** `<slug>.<platform-domain>` at creation (the platform domain is configuration, `mycel.site`-style; a self-hoster uses their own). It works before DNS, serves as preview and staging, and is the fallback if a custom domain fails verification.
3. **Custom domains are self-service**: the operator adds a hostname, Mycel shows the DNS records (CNAME or A/AAAA, plus a TXT verification token), verifies them from the worker, and marks the hostname verified. TLS is the reverse proxy's job (Caddy on-demand TLS asks the application `GET /internal/hostnames/allowed?domain=` and issues a certificate only for verified hostnames). No manual step on the box.
4. **The path form stays for development and for the admin.** `/{tenant}/...` is served only when no hostname matches and the request comes from a configured development host; the admin lives on the platform's own hostname under `/admin/{tenant}/...` and never on tenant domains, so operator cookies never travel to tenant sites.
5. **Locale stays in the path** (ADR 007), never in the hostname. One tenant, one primary hostname, locales under it.
6. **Absolute URLs come from one function** (`siteUrl(tenant, path, locale)`) that uses the primary hostname; e-mails, feeds, sitemaps, canonical links and the read route use it. No code builds a site URL from the request.

## Rejected alternatives

- **Path-based tenants in production** (`mycel.site/afvaloven-nee/...`): no DNS, no TLS work, and no organisation will accept it as its address. Cookies and caches would also be shared across tenants.
- **Wildcard certificate plus manual custom domains**: the Dreamkit way; every custom domain was a ticket. On-demand TLS makes it data.
- **Locale in the hostname** (`de.example.org`): a second hostname per locale per tenant, and `hreflang` across hosts; the path form is simpler and ADR 007 already decided it.

## Consequences

- `apps/web` gets a `handle` hook that resolves the tenant once per request from the hostname and puts it on `locals`; routes stop carrying `[tenant]` in production paths.
- `tenant_hostnames` is tenant data under forced RLS (ADR 002 rule 2): custom hostnames are written by the tenant's own use cases (`tenant.hostnames.*`, rule 3), the platform hostname by the platform path that creates the tenant (rule 2). Resolving a hostname happens before a tenant context exists and therefore reads through `mycel_auth` (ADR 011 rule 1), like an API key; `mycel_app` sees only its own hostnames. The uniqueness of a hostname is global.
- The hosting runbook (private) documents the Caddy `on_demand_tls` block; the public repo ships the `allowed` endpoint and a `Caddyfile` example.
- Implemented by PR #8 (hostnames and custom domains).
