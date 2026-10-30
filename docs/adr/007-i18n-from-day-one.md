# ADR 007 - Every string and every piece of content is localisable from day one

- **Status**: accepted
- **Date**: 2026-10-21
- **Rule 1 corrected**: 2026-10-30. The domain catalogs live in `packages/core/src/i18n/`; the original wording named `packages/core/i18n/`, a path that never existed.
- **Rule 5 refined**: 2026-10-30. A transactional mail that answers a submission (the subscription confirmation) is rendered in the locale of that submission, the language the recipient used a moment earlier; the supporter's preferred locale applies to campaign mail and to transactional mail no submission caused, once that property is projected. The original wording is retained below.

## Context

Dreamkit already serves Dutch, German (SPD Lüdenscheid), Italian (Comitato Tre Ottobre) and English-speaking organisations, and a client with members in two languages (Republiek) wants bilingual pages. Retrofitting i18n is the classic refactor swamp: it touches every template, every e-mail, every validation message and the content model. It is cheap now and prohibitively expensive later.

## Decision

1. **Three separate concerns, each with its own mechanism**:
   - **UI copy** (admin, public chrome, validation messages, e-mail boilerplate): message catalogs per locale in `packages/core/src/i18n/<locale>.ts` for domain messages and `apps/web/src/i18n/` for UI, typed keys, `Partial` dictionaries with fallback merge to the default locale. Copy never lives in components or services.
   - **Content** (pages, blocks, forms, e-mail campaigns): every localisable field is stored as `{ [locale]: value }`, not as a separate document per language. A document declares its available locales and a default; renderers fall back to the default and emit `hreflang` plus `x-default`.
   - **Data formatting** (dates, numbers, amounts, plurals): `Intl` only, locale taken from the tenant default or the visitor's negotiated locale. No formatting library.
2. **Locale is a tenant setting with a default and an allowed set.** A tenant with one locale sees no language UI at all; the model is still there.
3. **Routing without route duplication**: default locale unprefixed, other locales under `/<locale>/`, one route file per page. Never a `routes/nl/` copy.
4. **Platform default locale is `en`, product default for a Dutch tenant is `nl`.** Admin UI ships in `nl` and `en` from the first release; `de` follows when the first German tenant onboards.
5. **Transactional and campaign e-mail are rendered per recipient locale**, with the supporter's preferred locale as an event-derived property (ADR 003) and the tenant default as fallback. (Refined 2026-10-30: a mail answering a submission uses that submission's locale.)

## Rejected alternatives

- **One language first, add i18n later**: see Context. Every project that said this shipped a `nl/` folder copy.
- **Separate document per locale with a `translation_of` link**: how WordPress multilingual plugins work. It makes "is this page fully translated" a join and desynchronises block structure between languages.
- **A heavy i18n framework (i18next, Paraglide, inlang)**: fine libraries, but typed catalogs plus `Intl` cover the need, and the content side is a data-model question no library solves.

## Consequences

- Schemas for localisable fields use a shared `localized(schema)` helper; a block prop that should be localisable but is not is a review finding.
- Tests render every block in two locales to catch hard-coded strings.
- Machine translation is an optional, explicit action on a document (through MCP or the admin), never automatic.
