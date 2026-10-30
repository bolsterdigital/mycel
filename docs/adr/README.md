# Architecture decision records

The contract the code is built against. How a decision gets here, and when one is superseded instead of edited: [ADR 000](000-adr-process.md). The status column repeats each file's `Status` line; `npm run lint:infra` fails when they differ or a file is missing from this table.

| ADR | Decision                                                                                                                         | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 000 | [How decisions are recorded here](000-adr-process.md)                                                                            | accepted |
| 001 | [The domain core is framework-free; everything else is an adapter](001-framework-free-core.md)                                   | accepted |
| 002 | [One Postgres, `tenant_id` on every row, Row Level Security](002-single-postgres-rls-tenancy.md)                                 | accepted |
| 003 | [A supporter is an e-mail-centric identity plus an append-only event log](003-supporter-identity-and-event-log.md)               | accepted |
| 004 | [Content is a tree of schematised blocks; client differences are data](004-content-as-schematised-blocks.md)                     | accepted |
| 005 | [Donations and subscriptions are an owned ledger; the PSP is an adapter](005-money-ledger.md)                                    | accepted |
| 006 | [Open core under AGPL-3.0, DCO instead of CLA, trademark reserved](006-open-core-licensing.md)                                   | accepted |
| 007 | [Every string and every piece of content is localisable from day one](007-i18n-from-day-one.md)                                  | accepted |
| 008 | [Current stack picks and the policy for accepting dependencies](008-stack-and-dependency-policy.md)                              | accepted |
| 009 | [HTML first, accessibility by construction, and every operation exposed to agents](009-accessibility-standards-and-mcp-first.md) | accepted |
| 010 | [Forms and mailing are built in; delivery and spam defence are bought or standardised](010-forms-and-mailing-built-in.md)        | accepted |
| 011 | [Background work crosses tenants through a dedicated role and the outbox only](011-background-roles-and-outbox.md)               | accepted |
| 012 | [Content types, authors, publishing lifecycle and the read route](012-content-types-and-publishing.md)                           | accepted |
| 013 | [The customisation ladder: how far a tenant may deviate, and how bespoke work lands](013-customisation-ladder.md)                | accepted |
| 014 | [Tenants are resolved from the hostname; custom domains are tenant data](014-tenant-hostnames-and-routing.md)                    | accepted |
| 015 | [One codebase, no editions: features and limits are tenant entitlements](015-entitlements-as-data.md)                            | accepted |
| 016 | [Readers are supporters with a session; access to content is enforced server-side](016-readers-access-and-paywall.md)            | accepted |
| 017 | [A tenant is one site; an organisation with several sites has several tenants](017-tenant-is-one-site.md)                        | accepted |
| 018 | [Publishing, sending and access are precise operations](018-precise-editorial-operations.md)                                     | accepted |
| 019 | [Supporter consistency, stable identity, effect recovery and retention](019-supporter-consistency-identity-and-retention.md)     | accepted |
| 020 | [Editing surfaces, stable block identity and revisioned operations](020-editing-surface-and-block-operations.md)                 | accepted |
| 021 | [Assistance is a suggestion](021-assistance-is-a-suggestion.md)                                                                  | accepted |
| 022 | [Managed extensions and site integrations](022-managed-extensions-and-site-integrations.md)                                      | accepted |
| 023 | [Configurable forms, notifications and actions are baseline capabilities](023-configurable-forms-and-actions.md)                 | accepted |
| 024 | [Managed integrations and explicit external ownership](024-managed-integrations-and-external-ownership.md)                       | accepted |
