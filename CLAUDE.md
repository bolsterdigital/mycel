# Mycel - agent context

Open-core successor to Dreamkit: campaign sites, forms, donations, supporters and mailing in one EU-hosted application. AGPL-3.0, TypeScript monorepo. This file is also `AGENTS.md`.

**Read first, every session**: `docs/adr/` (the contract you build against), `docs/architecture/overview.md` (package map and import rules), `docs/architecture/testing.md` (which conformance suite your change must grow) and, when reviewing, `docs/architecture/review.md` (the six-field record, one extra counterproof at most, `scripts/review-signals.mjs`). A brief or TODO item that contradicts an accepted ADR is wrong until the ADR is superseded: stop and flag it.

## Commands

```sh
npm install
npm run verify      # format:check + lint:deps + typecheck + test + build; run before every PR
npm run format      # fix formatting
npm run test        # vitest
npm run dev         # apps/web
```

CI runs `verify` plus a DCO check (`.github/workflows/verify.yml`). Commits are signed off: `git commit -s`.

## Frozen design decisions (summary; the ADRs are authoritative)

- **`packages/core` is framework-free** and imports no I/O library; adapters implement its ports; fronts call its use-case registry. `scripts/check-dependency-rules.mjs` enforces direction and licences (ADR 001, 006, 008).
- **One Postgres, `tenant_id` on every tenant-owned row, forced RLS**, tenant context from authentication via `set_config` per transaction, never from a payload (ADR 002).
- **Supporter = normalised e-mail + append-only event log + projection**; envelope `wings.supporter-event.v1` inherited from Dreamkit (ADR 003).
- **Pages are JSON block trees with Zod schemas; rendering is an adapter; ordinary client differences are validated data, and reviewed managed extensions have a versioned contract** (ADRs 004, 022).
- **Where Mycel owns charging, donations and subscriptions use its ledger and explicit state machines; Mollie is an adapter; an externally owned subscription cannot trigger a second Mycel charge** (ADRs 005, 024).
- **Every localisable string or field is localisable from the start**; copy in i18n catalogs only (ADR 007).
- **HTML first, JavaScript as enhancement, axe gate in CI; every use case is an MCP tool with the same authorization** (ADR 009).
- **Forms and mailing are available natively; ordinary forms include typed conditional fields, multiple per-form notifications and connector actions; delivery and spam defence follow the `formulieren-en-mail` checklist** (ADRs 010, 023, 024).
- **Background work crosses tenants only through a dedicated role and the outbox** (ADR 011).
- **Two content types, `page` and `article`, one block tree; authors and sections are entities; status plus revisions; a newsletter issue is an article with e-mail delivery; rich text is constrained ProseMirror JSON; published content has a cached read route** (ADR 012).
- **Customisation ladder: validated theme values, block variants, patterns and composed blocks; platform-maintainer-installed packages may serve selected sites without compulsory upstream inclusion; no arbitrary tenant CSS/code uploads** (ADRs 013, 022).
- **Managed CMP, tags and embeds require route, consent, preview and fallback controls; selective loading does not isolate server code** (ADR 022).
- **External CRM, ESP and subscription ownership are supported tenant choices; connectors and one-off relays are inventoried and reconciled, with one owner per scope** (ADR 024).
- **Tenants resolve from the hostname; custom domains are tenant data with on-demand TLS; admin never runs on tenant domains** (ADR 014).
- **One edition; features and limits are an `entitlements` document per tenant, enforced in core; prices never in this repo** (ADR 015).
- **Readers are supporters with a magic-link session; content access is enforced server-side, teaser plus prompt for everyone else** (ADR 016).
- **A tenant is one site; an organisation with several sites has several tenants; nothing is shared across tenants by default** (ADR 017).
- **Scheduled publish pins a revision; saves carry `baseRevisionId`; a sent newsletter is an immutable edition; write, publish, send and export are separate capabilities; the teaser is explicit; access and caching apply to every representation; readiness is per locale** (ADR 018).
- **Supporters have a stable id; the projection is a fold in `occurred_at` order under a per-supporter lock; time-dependent state is evaluated at read time; external effects get an intent row, a provider idempotency key and reconciliation before retry; reader activity has a retention setting; erasure covers every copy** (ADR 019).

## Layout

```
packages/core/src/<module>/   model.ts · service.ts · ports.ts · events.ts · *.test.ts
packages/core/src/registry.ts the use-case registry every front reads
packages/db/migrations/       plain forward-only SQL; RLS policy next to each table
packages/api/src/             Hono app, auth middleware, route + OpenAPI generation
packages/mcp/src/             MCP server over the registry
apps/web/src/routes/          (public) tenant sites · (admin) operator UI
docs/adr/                     decisions · docs/plans → ../mycel-planning (private, gitignored)
```

Imports between workspaces go through package names (`@mycel/core`), never relative paths across packages.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`; ESM; Prettier 2 spaces, single quotes, 100 columns.
- Config files and non-trivial modules open with a _why_ comment including the rejected alternative.
- Public UI: native elements first, no ARIA where semantics suffice, works without JavaScript. Admin may be interactive but passes the same axe gate.
- English in code, docs and ADRs (public repo). Dutch in the private planning sibling. No em dashes in prose.
- Never commit secrets, client data or prices: this repo is public. Those live in private siblings.

## Werkwijze

Deze repo volgt de universele werkwijze (skill `werkwijze` in `~/.claude`):

- **Nu**: `docs/plans/TODO.md` - claimbord + open werk, budget < 300 regels.
- **Briefs**: `docs/plans/briefs/<slug>.md`; uitgevoerd -> `docs/plans/done/`.
- **Handoff per lane**: `/handoff` leest `docs/plans/handoff/<lane>.md` (`mbp` of `dev`) plus het gedeelde `handoff/queue.md`; elke werk-afrondende sessie overschrijft alleen het bestand van haar eigen lane en sluit af met de sluitregel. `docs/plans/HANDOFF.md` is een stub.
- **Lanes**: `dev` bouwt platform en operatie, `mbp` content en publicatie; welke code en welke TODO-items bij welke lane horen, hoe gedeelde registratiepunten en migratienummers werken: `docs/plans/lanes.md`. Bouw alleen items van je eigen lane.
- **Rollen**: het stuur-model brieft, beslist en reviewt; het uitvoer-model voert één brief per sessie uit op een branch en merget nooit de eigen PR. Welk model een rol nu heeft volgt uit `werkwijze` § Modelkeuze per sessie en `~/.claude/models.conf`.
- **Ritmes**: `merge-housekeeping` per gedelegeerde merge; `reorg-audit` bij de drift-drempel; `tighten-scan` op aanvraag.

Afwijkingen van de universele werkwijze:

1. **`docs/plans/` is een symlink naar de private sibling `../mycel-planning`** (deckyard-model), omdat deze repo publiek is. Planning-commits gaan in die sibling; verse checkout: `ln -s ../../mycel-planning docs/plans`.
2. **Alle commits zijn signed-off** (`git commit -s`, DCO, ADR 006); CI weigert PR's zonder.
3. **Review-en-merge volgt `docs/architecture/review.md`** en registreert tijdens de pilot (tot 2026-11-06 of twaalf reviews) elke review in `docs/plans/reference/review-pilot-2026-10.md`: signals-blok, gekozen lens, bestaand bewijs, minuten. Hooguit één extra tegenproef per PR; nooit een fix of merge uit de review zelf.

## Relation to Dreamkit

`../dreamkit` (WordPress platform) and `../dreamkit-supporter-registry` (Hono service) are the predecessors. Read them for behaviour to preserve and for the event contract; never import from them. Client work stays in the Dreamkit client repos until a tenant migrates; migration is a brief, not a side effect.
