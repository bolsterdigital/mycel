# Entitlements

What one tenant may use, as data on the tenant: a flat document of feature switches and numeric limits on `tenants.entitlements`, plus a separate `tenants.status`. There is one edition; a hoster narrows it per tenant with this document, never with code or a plan name, and prices never appear (ADR 015, [`../adr/015-entitlements-as-data.md`](../adr/015-entitlements-as-data.md)). The code is `packages/core/src/entitlements/` (model, guards, usage port, the two queries). The platform sets the document and the status through the routes and CLI in [platform-api.md](platform-api.md), which also has the per-key table of where each key is enforced; every such change is audited ([audit.md](audit.md)).

## The document

`Entitlements` (`model.ts`) is one strict Zod object with three kinds of key:

| Kind             | Keys                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| switch           | `mailing.enabled`, `donations.enabled`, `custom_domain`, `api_keys`, `remove_branding`, `ai.assist` (`FEATURE_SWITCHES`)                                             |
| block types      | `blocks`: `{ <type>: boolean }`; a type is on unless the document says `false`                                                                                       |
| limit (`LIMITS`) | `supporters.max`, `mail.monthly_max`, `media.storage_max_bytes`, `operators.max`, `custom_domains.max`, `ai.monthly_max`, `ai.pending_max`, `ai.operator_hourly_max` |

A limit is a non-negative integer. `LimitName` is the Zod enum of `LIMITS`; `FeatureName` is a switch or `blocks.<type>`.

The document has two readings:

- **Written** (`EntitlementsDocument`, the partial of `Entitlements`): any subset of the keys, each valid, nothing unknown. `parseEntitlementsDocument` (`packages/core/src/tenants/platform.ts`) refuses anything else with `invalid_input`. The platform stores exactly what the hoster sent.
- **Read** (`effectiveEntitlements(stored)`): lenient, merged over `DEFAULT_ENTITLEMENTS`. Every known key that parses wins, an unknown or invalid key is ignored, a missing key gets the default; `blocks` entries are taken one by one when boolean. An empty document means everything with the default limits, and an older build reads a newer document.

`DEFAULT_ENTITLEMENTS` switches everything on except `remove_branding` (so the footer credit shows by default, ADR 015 rule 5) and allows every block type. A self-hoster never has to set anything.

## Status

`TenantStatus` is `active` or `suspended`. It is not an entitlement (ADR 015 rule 7): it decides whether commands run at all. `guardSuspended` (`packages/core/src/invoke.ts`) runs in `Invoker.run` before authorization and refuses every command except one with `effect: 'export'` with `suspended`; queries keep working, so the public site stays readable and the admin stays open. `requireActive(principal)` (`guards.ts`) is the same answer for work outside the Invoker: the scheduled `content.publish` job calls it and, when suspended, plans itself again a day later with its pin instead of using up an attempt; `mail.reconcile` checks the status directly and does the same.

## Loaded, carried, enforced

**Loaded** before the tenant context exists, as `TenantAccess` (`{ entitlements, status }`, both effective):

- `IdentityStore.tenantAccess(tenantId)` (`packages/db/src/operators.ts`, as `mycel_auth`) for an API key, an agent session or an admin membership, for the content read route, and for every tenant job (`tenantJob` in `packages/api/src/jobs.ts` loads it just before the unit of work). It is not cached: a change shows on the next request. An unknown tenant gets `DEFAULT_ACCESS`.
- `SiteDirectory.resolve(hostname)` (`packages/db/src/hostnames.ts`, as `mycel_auth`) for a public page: the resolved site carries the tenant's access, cached per hostname for `SITE_CACHE_TTL_MS`, so a platform change reaches the public site within that window. `invalidate(hostname?)` clears it.

`mycel_app` never reads `tenants.entitlements` or `tenants.status`: it reads the `tenant_directory` view (migration 0008), which leaves both out (0010).

**Carried** on the `Principal` (`packages/core/src/principal.ts`) as `entitlements` and `tenantStatus`. `systemPrincipal(tenantId, job, access?)` without `access` carries the defaults and `active`; outbox subscribers use it that way, because ingest is not growth (the seat was reserved at the signup) and a confirmation mail belongs to a signup accepted before any suspension.

**Enforced** in core only, through the checks in `guards.ts`, all of which throw `UseCaseError('limit_exceeded')` (rendered as "ask your host", never a price):

| Check                                       | Refuses when                                                 | Issue message                |
| ------------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| `requireEntitled(principal, feature)`       | the switch is off, or `blocks.<type>` is `false`             | `entitlements.feature-off`   |
| `withinLimit(ctx, limit, current, add = 1)` | `current + add > max`; reaching the limit exactly is allowed | `entitlements.limit.<limit>` |

The assistance use cases check `ai.assist` and the three `ai.*` limits in their own gate (`packages/core/src/assist/service.ts`), refusing with `limit_exceeded` once a count has reached its maximum.

## `consumes`

A use case that grows something countable declares the limit it grows: `consumes: '<limit>'` on `defineUseCase` (`packages/core/src/registry.ts`). `checkRegistry` (`registry-rules.ts`) fails a `consumes` that is not a known limit, a query with `consumes`, and a command named `create`, `invite`, `add`, `submit` or `upload` that does not declare `consumes` (a limit, or `null` for "grows nothing countable"). The registry conformance (`registry.conformance.test.ts`) runs `examples[0]` of every consuming use case with that limit set to zero and expects `limit_exceeded`, so a declared limit that is never checked fails the build. Today: `form.submit` (`supporters.max`, for a new address only), `media.upload` (`media.storage_max_bytes`), `tenant.member.invite` (`operators.max`), `tenant.hostname.add` (`custom_domains.max`, after `custom_domain`), `assist.alt.suggest` and `assist.translation.suggest` (`ai.monthly_max`). Caps are enforced where growth starts, at a person's action, so background work does not fail on one.

## Usage

`UsageReader` (`ports.ts`, `ctx.usage`) counts on demand inside the tenant's transaction as `mycel_app` (`packages/db/src/usage.ts`), so the limit checks and the admin read the same numbers. Rejected: a materialized view.

| Method              | Counts                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `supporters()`      | rows of the supporter projection                                        |
| `mailsThisMonth()`  | `mail_sends` with `sent_at` in the current UTC calendar month           |
| `storageBytes()`    | every byte of every live asset, original and variants                   |
| `customHostnames()` | custom hostnames, verified or not; the platform hostname does not count |
| `operators()`       | memberships, pending invitations included                               |

Two queries, both `tenant:admin`: `tenant.usage.get` returns `{ used, max }` per limit (supporters, mail this month, storage in bytes, operators, custom domains) plus `status`; `tenant.entitlements.get` returns the effective document. Neither shows the stored document or a price. Setting entitlements is not a use case: it runs under no tenant, in `setEntitlements` and `setStatus` (`packages/db/src/platform.ts`, as `mycel_platform`), which validate, replace the stored document and write the audit row in one transaction.

## Constants

| Constant                  | Value     | Where                                     | Why                                                            |
| ------------------------- | --------- | ----------------------------------------- | -------------------------------------------------------------- |
| `supporters.max`          | 100 000   | `packages/core/src/entitlements/model.ts` | default; generous enough that a self-hoster never meets it     |
| `mail.monthly_max`        | 1 000 000 | `packages/core/src/entitlements/model.ts` | default; shown by `tenant.usage.get`, not yet enforced         |
| `media.storage_max_bytes` | 50 GiB    | `packages/core/src/entitlements/model.ts` | default; originals plus every variant                          |
| `operators.max`           | 50        | `packages/core/src/entitlements/model.ts` | default; members plus pending invitations                      |
| `custom_domains.max`      | 20        | `packages/core/src/entitlements/model.ts` | default                                                        |
| `ai.monthly_max`          | 2 000     | `packages/core/src/entitlements/model.ts` | default; proposals per calendar month                          |
| `ai.pending_max`          | 3         | `packages/core/src/entitlements/model.ts` | default; proposals pending in the last ten minutes             |
| `ai.operator_hourly_max`  | 30        | `packages/core/src/entitlements/model.ts` | default; one operator's proposals in the last hour             |
| `SITE_CACHE_TTL_MS`       | 30 s      | `packages/db/src/hostnames.ts`            | how stale the public site's entitlements and status can be     |
| `SITE_CACHE_MAX`          | 10 000    | `packages/db/src/hostnames.ts`            | hostnames in that cache, oldest out                            |
| `SUSPENDED_RETRY_MS`      | 24 h      | `packages/core/src/content/service.ts`    | when a scheduled publication of a suspended tenant looks again |
