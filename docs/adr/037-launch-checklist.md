# ADR 037 - The launch checklist is advisory: steps in code, state per site

- **Status**: accepted
- **Date**: 2026-11-20
- **Builds on**: ADR 002 (RLS), ADR 007 (localisation), ADR 009 (MCP, same authorization), ADR 011 (outbox and background work), ADR 014 (hostnames), ADR 015 (entitlements), ADR 035 (operator erasure)
- **Supersedes**: nothing

## Context

Taking a site live, or moving a Dreamkit site to Mycel, takes a few dozen steps by different people: a domain and its DNS, a payment provider switched from test to live, statistics, form notifications, a team that can log in, a home page, and the human steps around them (a go/no-go, a content freeze, a smoke test). Dreamkit's `wings-launch` showed that a living checklist per site, with an owner per step and checks that read the site's own state, replaces a static runbook that nobody keeps up to date. In Mycel the state those checks need already exists, spread over the domains, connections, settings and forms screens. This ADR fixes where the steps live, what a site stores, what a check may do and what the list may decide.

## Decision

1. **The steps are a register in code.** Each step has a stable id, a phase (`prepare`, `launch`, `after`), a default owner (`platform`: whoever hosts the installation; `organisation`: the organisation the site is for; `shared`), an optional group tied to a feature, and, when Mycel can establish it, a check. The register is the same for every site and changes with a release; a step id never changes meaning once released. Titles and explanations are catalog entries (ADR 007), never stored. Steps a site adds for itself are not part of this decision.

2. **A site stores only what a person decided.** Per site and step: ticked, a warning accepted, a note of at most 1000 characters, another owner, and switched on or off for this site. The row carries no operator id: who changed a step is in the audit row the command writes, so operator erasure (ADR 035) has nothing to find in it. A stored row for a step the register no longer has is ignored on read; writing to an unknown step is refused. The state is site configuration and travels with an export.

3. **A check only reads, at read time.** The list is computed on every read from the register, the stored state and facts read through the ports the owning modules already have, in a fixed number of reads whatever the site holds. A check is a pure function of those facts with the outcome `pass`, `warn` or `fail` and a catalog code with parameters. Outcomes are never stored, and a check never calls an external service or the site's own public address: a loopback or DNS probe makes the read slow and dependent on the network, and what it would measure is covered by gates or by the hostname verification of ADR 014.

4. **Whether a step applies follows the site's entitlements first.** A step in the group `giving` does not apply without `donations.enabled`, `mailing` without `mailing.enabled`, `domain` without `custom_domain` (ADR 015). A site administrator may switch any step on or off for the site, which overrides the default; clearing the override returns to it.

5. **The verdict.** A step is complete when it is ticked, when its check passes, or when its check warns and someone accepted the warning. A failing check cannot be accepted, only fixed or switched off. The site is ready to go live when every applicable step of `prepare` and `launch` is complete; `after` counts for progress, not for the verdict.

6. **The list advises; it never blocks.** Publishing, adding a domain, taking payments and sending mail do not consult the checklist. A site in Mycel is reachable as soon as it has a hostname, so there is no single "go live" act to gate, and a gate would turn a forgotten tick into an outage.

7. **Reading and changing the list need `tenant:admin`,** the capability of the domains and members screens; the facts are read through ports, not through the other modules' use cases, so no further capability is needed and nothing more is disclosed than an administrator already sees. `launch.checklist.get` and `launch.step.update` are MCP tools with the same authorization (ADR 009). The use cases run in the tenant's transaction under RLS (ADR 002); there is no cross-tenant view.

## Consequences

- A check that needs state Mycel does not keep yet (whether a payment key is live, a stored import report) is a manual step until that state exists, then becomes a check in a release without a migration of the stored state.
- A new step reaches every site with the release; a site sees it open unless its group does not apply.
- A site-specific step, a launch report for the organisation, a ticket link per step and a "launched on" moment are possible later additions, not part of this decision.
