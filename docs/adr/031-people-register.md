# ADR 031 - An author is a role of a person

- **Status**: accepted
- **Date**: 2026-11-09
- **Supersedes**: ADR 012 rule 2 (authors as a separate entity)
- **Preserves**: ADR 027's compare-and-set entity updates, ADR 002 tenant isolation, ADR 018 immutable revisions and publication, ADR 007 localised content

## Context

A writer, image maker and team member can be the same person. Separate identities would duplicate names and contact data. A person must also exist without a public profile page.

## Decision

1. A tenant has one `people` register. Name, slug, localised bio, image and links remain; localised role, organisation, phone, separate `publicEmail` and `pagePolicy` extend the record. Existing `email` remains internal and never becomes public by migration or fallback. A link's optional kind defaults semantically to `other` when absent.
2. Existing authors become people with their ids and timestamps unchanged. Stored documents retain `authorIds` and reference type `author`: author is a role, and historical revisions are never rewritten. Editorial operations become `content.person.*` with the existing read/write capabilities and concurrency contract. Operator accounts remain separate.
3. Ordered, localised `person_groups` have ordered memberships; one person may belong to multiple groups. A group replacement and its memberships are one transaction on `baseUpdatedAt`. Both tables have forced RLS and composite tenant foreign keys.
4. The pure `personPageStatus(site, person, publishedArticleCount)` decides page availability. Site `personPages: off` wins, then person `pagePolicy: never`, then `always`, then `auto` requires at least one published article. Missing site configuration means `auto`; new people default to `auto`. A bio alone never enables a page.
5. Public routes, links, sitemaps and structured data must use that decision. An unavailable profile returns the same 404 as an unknown person. The future route is `/people/<slug>` with the ordinary locale prefix. Public projections explicitly select fields and never include internal email.
6. Tenant portability includes people, groups and membership order. Old archives containing `authors` import into `people`; no historic content revision changes. Profile deletion, erasure and image credits are separate implementation steps, not implied by creating this register.

## Rejected alternatives

- Separate author, photographer and team directories: multiple records for one human drift.
- A person as a third block-document type: people exist without pages and without a publication lifecycle.
- A site switch read independently in templates: links and routes could disagree about exposure.
- Rewriting revision author ids: the role remains valid and historical attribution must stay intact.

## Consequences

The first implementation supplies the model, editorial registry, groups, migration, page decision and portability. Management screens, public profiles and image-maker links follow separately. `Author` remains a type/schema alias for consumers of stored author references. The SQL table is renamed in place before the first production tenant; no row is deleted or copied. Existing public bylines stay plain names until the public route is implemented.
