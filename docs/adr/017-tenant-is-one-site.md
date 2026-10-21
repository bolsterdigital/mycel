# ADR 017 - A tenant is one site; an organisation with several sites has several tenants

- **Status**: accepted
- **Date**: 2026-10-21
- **Amends**: ADR 014 (one primary hostname per tenant), ADR 015 (removes `sites.max`)
- **Prompted by**: second-opinion review of 2026-10-21 (`mycel-planning/reference/platformreview-2026-10-21.md`, finding 1)

## Context

ADR 014 gives every tenant exactly one primary hostname, while ADR 015 lists `sites.max` as a limit, which implies several sites inside one tenant. A publisher with two titles and a campaign site makes the question concrete: three tenants, or one tenant with three sites that share readers, subscriptions, authors and newsletter consent? Every later decision (RLS, cookies, read route, feeds, entitlements) depends on the answer, so it is decided now.

## Decision

1. **A tenant is one site: one publication or one campaign organisation on one primary hostname.** Everything tenant-owned (content, authors, sections, supporters, lists, ledger, access tiers, theme, entitlements) belongs to that one site. There is no `site` entity below the tenant and no `sites.max` limit.
2. **An organisation that runs several sites runs several tenants.** Grouping them is a hosting concern (billing, one invoice, one operator logging in to several tenants through memberships, ADR 002 and TODO #7), not a platform entity. The platform API may expose an `organisation` label on tenants for the hoster's convenience; it carries no behaviour.
3. **Nothing is shared across tenants by default**: a reader of title A is a separate supporter in title B, with separate consent and separate subscriptions. This is the privacy-safe default and matches the RLS model (ADR 002).
4. **Sharing across sites is a later, explicit feature, never an implicit join.** Candidates, each a future ADR with its own consent story: single reader sign-in across the tenants of one organisation, a shared author directory, a bundle subscription that grants access in several tenants. They would be built as cross-tenant read models and events (ADR 011 rule 1), not by weakening isolation.

## Rejected alternatives

- **Tenant = organisation with a `site` entity**: shared readers and subscriptions come for free, but every table, policy, cookie, URL builder and entitlement gains a second key, and the hostname-to-tenant resolution of ADR 014 becomes hostname-to-site-to-tenant. The cost lands in fase 1; the benefit is needed by organisations we do not have yet.
- **Leaving it open**: the reviewer's point. Open means every builder decides it locally.

## Consequences

- ADR 015 rule 2: `sites.max` is removed from the entitlements schema; the hoster counts tenants.
- ADR 014 stays as written: one primary hostname, other hostnames redirect.
- `tenant.usage` (ADR 015 rule 6) drops `sites`.
- A reader session cookie is bound to one tenant hostname (ADR 016 rule 1) and that is the whole story in v1.
