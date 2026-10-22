# Hostnames and custom domains

How a request finds its tenant (ADR 014), what an operator does to put a site on their own domain, and what the hosting needs. The private hosting runbook has the production values; this page has the mechanism.

## Resolution

A tenant has one or more hostnames in `tenant_hostnames` (migration 0008):

| kind       | made by                                     | verified        | removable           |
| ---------- | ------------------------------------------- | --------------- | ------------------- |
| `platform` | tenant creation: `<slug>.<PLATFORM_DOMAIN>` | from the start  | never               |
| `custom`   | the tenant's admin (`tenant.hostnames.add`) | by a TXT record | yes, unless primary |

Exactly one hostname per tenant is **primary**. The web app decides per request, in `apps/web/src/hooks.server.ts`:

1. `/healthz` and `/internal/*`: served on any host (Caddy and the orchestrator use the container's internal name).
2. `/admin` and `/admin/*`: only on the platform origin (`PUBLIC_BASE_URL`). On a tenant hostname the admin is a 404, so operator cookies never travel to tenant sites.
3. Any other path: the hostname is looked up. Primary: the site is served. Verified (or platform) but not primary: `301` to the same path and query on the primary hostname. Unverified custom hostname: `404`. Unknown hostname: `404`, unless the host is in `DEV_HOSTS`, where the first path segment is the tenant slug (`http://localhost:5173/probe/signup`, development only).

The lookup runs before a tenant context exists, through the `mycel_auth` role (ADR 011 rule 1), and is cached in the process for thirty seconds per hostname. The admin invalidates the entry it just changed, so its own change is live at once; a change made elsewhere is live within that window.

Absolute site URLs (the confirmation mail, `pageUrl` on a submission, later feeds and canonical links) come from one function, `siteUrl` in `packages/core/src/tenants/url.ts`: the primary hostname with the scheme and port of `PUBLIC_BASE_URL`. Nothing builds a site URL from the request.

## Configuration

| Variable            | Meaning                                                                                                                                      | Development                     | Production           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------- |
| `PLATFORM_DOMAIN`   | Every tenant gets `<slug>.<PLATFORM_DOMAIN>` at creation.                                                                                    | `localhost`                     | a real domain        |
| `PUBLIC_BASE_URL`   | The platform origin: admin, OIDC redirect, and the scheme and port of every site URL.                                                        | `http://localhost:5173`         | `https://...`        |
| `DEV_HOSTS`         | Hosts that serve the `/{tenant}/...` path form when no hostname matches.                                                                     | `localhost,127.0.0.1` (default) | must be empty        |
| `SITE_URL_MODE`     | `hostnames`: site URLs use the primary hostname. `path`: the path form on `PUBLIC_BASE_URL` (tools that do not resolve `*.localhost`).       | `path` (default)                | `hostnames` (forced) |
| `MYCEL_TRUST_PROXY` | `1`: the web container reads host, protocol and client address from `x-forwarded-host`, `x-forwarded-proto` and `x-forwarded-for` (one hop). | `0`                             | `1` (required)       |

Browsers resolve `*.localhost` to loopback, so `http://probe.localhost:5173/signup` works in development without a hosts entry.

## Adding a custom domain (what the admin does)

In the admin of the site, section **Domains**:

1. **Add** the hostname (`www.example.org`; internationalised names are stored as punycode and shown in both forms). Nothing is served on it yet.
2. At the DNS provider, create the two records the page shows:
   - `TXT _mycel-verify.www.example.org` with the verification token. This proves control of the name.
   - `CNAME www.example.org` to the site's platform hostname (`<slug>.<PLATFORM_DOMAIN>`). An apex domain (`example.org` itself) cannot take a CNAME at most providers; the hoster documents the `A`/`AAAA` records to use instead. The TXT record is always required.
3. **Check DNS.** Mycel looks up the TXT record; when the token is there the hostname is verified. The page reports what it found otherwise (other TXT values, where the CNAME points), because DNS changes take time to spread. The CNAME is reported, never required: if DNS does not point at the platform, TLS simply never gets issued and nothing is served.
4. **Make primary.** From now on the site is served on the new domain and every other hostname of the site redirects to it. The platform hostname stays as a fallback and can be made primary again.

## Re-verification (what happens afterwards)

A custom hostname stays proven only while its TXT record is there. Adding a domain plans a check a day later (job `hostnames.reverify:<tenant>:<hostname>`), and every check plans the next one a day after it, whether the domain is verified or not, until the domain is removed. Checking DNS by hand in the admin does not move that schedule.

- **Record found**: the run of failures goes back to zero; a domain that had lost its verification is verified again (it does not become primary again by itself).
- **Record missing**: one failure is counted. After **three consecutive daily misses** (72 hours without the record) the verification is withdrawn: the domain stops being served and gets no new certificate, and if it was primary, the platform hostname becomes primary again (ADR 014 rule 2). Three days is the time an admin has to restore a record removed by accident; DNS hiccups and TTLs make a single miss weak evidence.
- **DNS did not answer** (server failure, time-out): nothing is counted and nothing changes; the next check is a day later. The admin's own check reports the same ("DNS did not answer") instead of an error.

The admin shows per custom domain when it was last checked and how many checks in a row missed the record. Sites resolve through a thirty-second cache, so a withdrawn domain can serve for up to half a minute longer. The check is the same `verifyHostname` function the admin's **Check DNS** calls; the policy is `reverifyHostname` in `packages/core/src/jobs/handlers.ts`.

## TLS (what the hosting does)

Caddy issues certificates on demand and asks the application first: `GET /internal/hostnames/allowed?domain=<host>` answers `200` (empty body) for the platform origin, a platform hostname and a verified custom hostname, and `404` for everything else. There is no list endpoint and no authentication: the answer is one bit the certificate would reveal anyway. `/internal/*` must not be reachable from outside; [`docker/caddy/Caddyfile`](../../docker/caddy/Caddyfile), the proxy of [`compose.yml`](../../compose.yml), blocks it and sets the forwarded headers the web container trusts with `MYCEL_TRUST_PROXY=1`. CI proves both with a real Caddy (`scripts/compose-proof.sh`, certificates from Caddy's own CA); the installation is [`docs/self-hosting.md`](../self-hosting.md).

## The API over HTTP and MCP

The same four use cases are available to an API key or an agent with `tenant:admin` (which a key never has, so in practice: the admin UI): `tenant.hostnames.list`, `tenant.hostnames.add`, `tenant.hostnames.verify`, `tenant.hostnames.set_primary`, `tenant.hostnames.remove`. The number of custom domains becomes an entitlement in TODO #16 (ADR 015).
