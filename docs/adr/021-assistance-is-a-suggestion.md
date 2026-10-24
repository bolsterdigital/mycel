# ADR 021 - Assistance is a suggestion

- **Status**: accepted
- **Date**: 2026-10-23

## Context

Editors repeat work when describing images and translating content. A model may help, but a model write would bypass revision conflicts, locale readiness and the separate power to publish. Drafts and restricted content may also leave the installation when a provider is called.

## Decision

1. Assistance consists of named `assist.*.suggest` use cases with schema-validated results. There is no general chat or model write to content.
2. A suggestion moves from `pending` to `ready` or `failed`, then to `accepted` or `dismissed`. Only an operator accepting it creates a content revision. That revision records the suggestion, task, provider, model and whether the operator edited the result. Acceptance never changes a publication pointer.
3. Core defines a `TextModel` port. Provider adapters live outside core. A worker calls the model outside the tenant transaction and stores only the validated result or a safe error class.
4. The hoster grants the `ai.assist` entitlement and the tenant explicitly enables the feature for a named provider. A different provider label invalidates that consent. Restricted content needs a separate opt-in.
5. Machine translation remains unreviewed per locale until an operator with `content:publish` approves it. An unreviewed locale is not ready for publication.
6. Accepting a suggestion or approving a translation requires an operator actor. API keys and MCP agents may request and read suggestions, but cannot claim a human accepted or approved one.

## Rejected alternatives

- A chat pane that writes directly to fields: it evades the revision and publication boundaries.
- One installation-wide AI switch: it cannot express a tenant's consent to a named processor.
- A synchronous provider call inside a use case: it holds a tenant transaction open for an external HTTP request.

## Consequences

The model can consume quota and may be called twice after a worker crash. The suggestion row remains tenant-owned operational data with retention; an accepted revision carries the durable text and provenance.
