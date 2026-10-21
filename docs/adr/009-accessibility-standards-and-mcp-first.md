# ADR 009 - HTML first, accessibility by construction, and every operation exposed to agents

- **Status**: accepted
- **Date**: 2026-10-21

## Context

The organisations Mycel serves are often legally required to publish accessibly (EU Web Accessibility Directive, European Accessibility Act from 2025) and are frequently audited. "Accessibility first" cannot mean a checklist at the end; it has to be a property of how pages are produced. The same holds for standards (open formats, HTTP semantics, OIDC, RFC-compliant mail) and for agent operability: an operation that only exists as a button is invisible to the people and agents who increasingly do the work.

## Decision

### Public rendering

1. **Server-rendered, semantic HTML is the product; JavaScript is enhancement.** Every public page, form and donation flow works with JavaScript disabled: native `<form>` posts, server-side validation, full-page responses. Client-side JS may improve the experience (inline validation, payment-method selection) but never gates it.
2. **One accessible implementation per block type** (ADR 004): landmarks, heading hierarchy from tree depth, native controls, visible focus, no colour-only meaning, `prefers-reduced-motion` respected. Themes cannot break contrast: the theme schema validates token pairs against WCAG 2.2 AA contrast at write time.
3. **Automated gates**: Playwright with axe on every block type and every flow in CI; a failing axe rule fails `verify`. Manual screen-reader passes are a release checklist item, not a substitute.
4. **Performance is part of accessibility**: no client framework payload on content pages beyond what the enhanced components need; self-hosted fonts; images served in modern formats with dimensions set; a budget enforced in CI.

### Standards

5. **HTTP semantics are honoured** (methods, status codes, caching headers, `ETag`, `Problem Details` for errors per RFC 9457). The API is described by an OpenAPI 3.1 document generated from the Zod schemas, not written by hand.
6. **Open formats everywhere**: JSON for content and export, iCalendar for events, CSV and JSON for supporter exports, RFC 8058 one-click unsubscribe, SPF/DKIM/DMARC for every sending domain, OIDC for operator login, WebAuthn when we add passwordless for donors.

### MCP first

7. **Every use case in `packages/core` is exposed as an MCP tool with the same authorization as the HTTP API and the UI.** The MCP server lists tools from the same registry the API routes are generated from; there is no separate "agent surface" to keep in sync.
8. **Resources for reading, tools for acting, prompts for recipes.** Pages, forms, supporters and campaigns are MCP resources; mutations are tools with Zod-described inputs; recurring editorial tasks (new campaign page, thank-you flow) ship as MCP prompts.
9. **Agent actions are attributed and reversible where possible**: every mutation records the acting principal (human, API key, agent session); content mutations are versioned with a diff.

## Rejected alternatives

- **SPA admin for everything, public pages included**: fast to build, and the exact architecture that produces inaccessible donation forms and 400 kB of JavaScript for a petition.
- **Accessibility overlay or audit-at-release**: both well-known not to work.
- **Hand-written OpenAPI and a separate MCP tool list**: drifts within a month.

## Consequences

- The web app's component library starts from native elements with styling, not from a headless UI kit with re-implemented semantics.
- Adding a use case is: core function, schema, registry entry. HTTP route, MCP tool and OpenAPI entry follow from the registry.
- The admin UI may use client-side interactivity freely (it is for operators, behind login) but is held to the same axe gate.
