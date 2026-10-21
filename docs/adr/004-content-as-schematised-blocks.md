# ADR 004 - Content is a tree of schematised blocks; client differences are data

- **Status**: accepted
- **Date**: 2026-10-21

## Context

Dreamkit sites are a shared WordPress block theme plus per-client CSS, patterns and the occasional plugin. The useful lesson: editors could only choose content and layout, never colours or fonts, and every site rendered the same block set. The painful lesson: block markup lived in PHP templates and Gutenberg's serialised HTML, which made the content neither portable nor machine-readable, and per-client code crept in anyway.

## Decision

1. **A page is a JSON document: metadata plus an ordered tree of blocks.** Each block has a `type`, a schema version and typed `props`. The block registry in `packages/core` defines every type with a Standard Schema (Zod) that validates on write. Unknown block types are rejected, not silently stored.
2. **Rendering is an adapter.** `packages/core` knows nothing about HTML. A renderer (first: Svelte components in `apps/web`, server-rendered) maps block type to markup. A second renderer (e-mail, PDF, static export) can exist without touching the content model.
3. **Every block renders to semantic HTML by default**: landmarks, heading levels derived from tree depth, native form controls, no ARIA where native semantics suffice. Accessibility is a property of the renderer, tested once per block type, not of each page.
4. **Client differences are data, never code.** A tenant has a theme: design tokens (colour roles, type scale, radius, spacing), a font pair from a self-hosted set, logo and a small set of layout choices. Themes validate against a schema. There is no per-tenant CSS file, template override or plugin.
5. **The block set is deliberately small and grows by ADR-free registry entry, but a block type's schema only changes by versioned migration**: `props` migrate forward with a per-type function; old documents are migrated on read until a batch migration lands.
6. **Dynamic blocks (form, donation, signup, event list) carry a reference, not a copy.** A form block references a form definition; the form domain owns the fields and the submissions. Deleting a form with live references is refused.

## Rejected alternatives

- **Markdown or MDX as the content format**: excellent for docs, bad for campaign pages that are mostly structured components. The dynamic blocks have no natural Markdown form.
- **Portable Text, Lexical or TipTap JSON**: good rich-text models and one of them will likely be used _inside_ a rich-text block. As the page model they bind the content to an editor's node model, which is the Gutenberg lesson again.
- **Per-client themes as code (SvelteKit "theme packages")**: maximum flexibility, and within a year every client is a fork. Dreamkit's `clients.yml` plus per-site CSS proved that the escape hatch gets used.

## Consequences

- An agent can read, write and reason about any page via MCP without parsing HTML.
- A page export is a JSON file a competitor could import. That is intended: the moat is the platform, not the lock-in.
- Design tokens map to CSS custom properties in one place (`apps/web/src/lib/theme`), following the house style (layered CSS, tokens with role names, fluid type scale).
