# Mycel - agent context

Open-core successor to Dreamkit: campaign sites, forms, donations, supporters and mailing in one EU-hosted application. AGPL-3.0, TypeScript monorepo. This file is also `AGENTS.md`.

**Read first, every session**: `docs/adr/` (eleven short files, the contract you build against) and `docs/architecture/overview.md` (package map and import rules). A brief or TODO item that contradicts an accepted ADR is wrong until the ADR is superseded: stop and flag it.

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
- **Pages are JSON block trees with Zod schemas; rendering is an adapter; client differences are data** (ADR 004).
- **Donations and subscriptions are an owned ledger with explicit state machines; Mollie is an adapter** (ADR 005).
- **Every localisable string or field is localisable from the start**; copy in i18n catalogs only (ADR 007).
- **HTML first, JavaScript as enhancement, axe gate in CI; every use case is an MCP tool with the same authorization** (ADR 009).
- **Forms and mailing are built in; delivery (TEM/SMTP) and spam defence (ALTCHA, honeypot, rate limits) follow the `formulieren-en-mail` checklist** (ADR 010).

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
- **Handoff**: `/handoff` leest `docs/plans/HANDOFF.md`; elke werk-afrondende sessie overschrijft 'm en sluit af met de sluitregel.
- **Rollen**: het stuur-model brieft, beslist en reviewt; het uitvoer-model voert één brief per sessie uit op een branch en merget nooit de eigen PR. Welk model een rol nu heeft volgt uit `werkwijze` § Modelkeuze per sessie en `~/.claude/models.conf`.
- **Ritmes**: `merge-housekeeping` per gedelegeerde merge; `reorg-audit` bij de drift-drempel; `tighten-scan` op aanvraag.

Afwijkingen van de universele werkwijze:

1. **`docs/plans/` is een symlink naar de private sibling `../mycel-planning`** (deckyard-model), omdat deze repo publiek is. Planning-commits gaan in die sibling; verse checkout: `ln -s ../../mycel-planning docs/plans`.
2. **Alle commits zijn signed-off** (`git commit -s`, DCO, ADR 006); CI weigert PR's zonder.

## Relation to Dreamkit

`../dreamkit` (WordPress platform) and `../dreamkit-supporter-registry` (Hono service) are the predecessors. Read them for behaviour to preserve and for the event contract; never import from them. Client work stays in the Dreamkit client repos until a tenant migrates; migration is a brief, not a side effect.
