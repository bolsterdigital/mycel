# ADR 013 - The customisation ladder: how far a tenant may deviate, and how bespoke work lands

- **Status**: accepted
- **Date**: 2026-10-21
- **Refines**: ADR 004 rule 4 (client differences are data)
- **Rule 5 and absolute exclusions partly superseded**: 2026-10-24 by [ADR 022](022-managed-extensions-and-site-integrations.md). General upstream inclusion is optional for reviewed managed packages; arbitrary tenant CSS/code uploads and hidden style overrides remain excluded. Rungs 1 to 4 remain the default self-service options.

## Context

Opinionated design is a product value: every Mycel site is accessible, fast and coherent because tenants cannot break it. The commercial reality is that paying clients ask for "just this one thing", and that a hoster who also designs wants to deliver it quickly. Dreamkit answered with per-client CSS and the escape hatch became the norm. ADR 004 forbids per-tenant code but does not say what tenants may change, nor how a bespoke request is fulfilled without a fork. Agents need that line drawn or they will draw it differently each session.

## Decision

The ladder, from most to least common. Rungs 1 to 4 are self-service and available to every tenant; rung 5 is how bespoke work enters the product.

1. **Theme values, not only presets.** The `Theme` schema (TODO #8) accepts arbitrary values inside validated ranges: any colour for each role pair as long as every text/background pair meets WCAG 2.2 AA (and AAA for body text is reported, not required); type scale ratio, base size, measure, radius, spacing density and heading weight within bounded ranges; one font pair from the curated self-hosted set, plus one uploaded wordmark font per tenant. Presets are starting points that produce such values. Dark mode is derived or explicitly set per pair.
2. **Block variants.** A block type may declare an enumerated `variant` (`hero: cover | split | minimal`, `cta: band | card`) and a small set of layout props (`width: content | wide | full`, `align`). Variants are implemented once in the renderer, tested once, and are the only layout freedom per block.
3. **Patterns and site chrome.** Patterns (ADR 012 rule 8) and the `SiteChrome` document (navigation, footer, legal links, announcement bar, social links) are data every tenant edits.
4. **Composed blocks.** A tenant may save a block subtree with named slots as a reusable composed block (a pattern with parameters). Still data.
5. **Bespoke blocks go upstream, enabled per tenant.** When a client needs something the ladder does not cover, a new block type or variant is built in this public repository, generalised and named by what it does (never by the client), tested like every block, and switched on for that tenant through an entitlement (ADR 015, `blocks.<type>`). The client pays for the work; the product keeps the block; every other tenant may get it later. The same applies to themes: a new font or a new layout option is a product change.

What never exists: per-tenant CSS, template overrides, injected HTML or scripts, a tenant-selectable "custom code" field, or a build step per tenant. A hosted-service "design service" uses rungs 1 to 5 and nothing else; the hoster has no backdoor the self-hoster lacks.

## Rejected alternatives

- **Custom CSS field with sanitisation**: the single most requested escape hatch and the one that destroyed coherence and accessibility in Dreamkit. Once it exists, no design decision is final.
- **Tenant theme packages as code** (already rejected in ADR 004): every client becomes a fork.
- **Presets only, no free values**: honest and simple, but the first real brand will not fit a preset, and the hoster would reach for a hack. Validated ranges keep the guarantee (contrast, legibility) while admitting any brand.

## Consequences

- `Theme` carries no raw CSS; the mapping to custom properties lives in `apps/web/src/lib/theme` and is the only place that knows CSS.
- Contrast validation runs in `core` on theme write and is also exposed as a query (`theme.check`) so the admin shows it live and an agent can call it.
- The block registry records per block type its variants and layout props; the block conformance test (`docs/architecture/testing.md`) renders every variant.
- A bespoke request becomes a brief in the public repo plus an entitlement change in hosting; the decision log notes which client asked, in the private planning sibling only.
