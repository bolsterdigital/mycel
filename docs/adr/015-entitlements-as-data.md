# ADR 015 - One codebase, no editions: features and limits are tenant entitlements

- **Status**: accepted
- **Date**: 2026-10-21
- **Builds on**: ADR 006 (open core boundary is the repository boundary)
- **Amended**: 2026-10-21 by ADR 017 (`sites.max` removed) and rule 7 below (over-limit, suspension and leaving); 2026-10-22 by TODO #16 (`custom_domains.max` added to rule 2); 2026-10-22 by TODO #16 (rule 4: the platform role)

## Context

Adoption of an open-source platform comes from people being able to run it and from a hosted offer with a low entry. Both invite the same mistake: an "enterprise" edition, a feature matrix in code, or `if (plan === 'pro')` scattered through services. ADR 006 already says the public repository is the whole product. What is missing is how a hosted free tier, a paid tier and a bespoke block (ADR 013) can differ per tenant without touching that rule.

## Decision

1. **There is one edition.** A self-hoster has every feature. Nothing in the public repository is disabled by licence key, build flag or edition.
2. **Differences per tenant are an `entitlements` document**, platform data on the tenant: feature switches (`blocks.<type>`, `mailing.enabled`, `donations.enabled`, `custom_domain`, `api_keys`, `remove_branding`) and limits (`supporters.max`, `mail.monthly_max`, `media.storage_max_bytes`, `operators.max`, `custom_domains.max`; the last added 2026-10-22, because a free tier without its own domain needs a count as well as the `custom_domain` switch). The schema lives in `packages/core`; the defaults grant everything with generous limits, so a self-hoster never has to think about it.
3. **Enforcement happens in `core`, once per use case**, through the `Principal` (which carries the tenant's entitlements) and an `entitled(principal, feature)` or `withinLimit(ctx, limit, current)` check. A use case that exceeds a limit fails with a typed error the fronts render as "upgrade or contact your host". Hosts, not Mycel, decide what a tier costs; prices never appear in this repository.
4. **The hosted service sets entitlements through the platform API** (`/platform/*`, as the dedicated `mycel_platform` role, ADR 011 rule 1), from its private billing system (the client portal). The open-source instance's single operator sets them with the CLI or leaves the defaults.
5. **A footer credit ("Runs on Mycel") is on by default** and is the one entitlement (`remove_branding`) the hosted free tier keeps switched off. It is a visible link, never tracking.
6. **Usage is measured, not guessed**: `tenant.usage` is a read model (supporters, mails this month, storage) that both the limit checks and the hosted billing read.

7. **Over a limit, suspended or leaving, the tenant keeps what it has.** Exceeding a limit blocks only the action that would grow it (no new supporters, no more mail this month); existing content stays published and readable. A suspended tenant (`status: suspended`, set by the hoster) serves its public site read-only and keeps the admin open for export only. `tenant.export` (ADR 002 rule 5) is never gated by an entitlement or a suspension. Deleting a tenant first cancels its running subscriptions at the provider (ADR 005) and then removes data after a documented retention window; both steps are logged.

## Rejected alternatives

- **Open core with a private "pro" package**: the standard commercial model, and incompatible with the claim that the public repository is the product; it also makes AGPL enforcement politically awkward.
- **Plans as an enum in code** (`free | pro | business`): forces the product to know pricing, and every new tier is a code change. Named entitlements let hosting invent tiers freely.
- **No limits at all**: a free hosted tier without caps is a spam vector and an unbounded cost; a self-hoster may simply raise the defaults.

## Consequences

- `Principal` gains `entitlements`; the composition root loads them with the tenant and caches per request.
- Each use case that creates something countable declares which limit it consumes; the registry conformance test asserts a limit check exists for those.
- The hosted free tier and paid tiers are a decision for the hoster (for Bureau Bolster: the private planning sibling and the client portal), not for this repository.
- `ROADMAP` item: entitlements and usage read model land in fase 1 (TODO #16) because the first hosted tenants need the caps and the branding switch.
