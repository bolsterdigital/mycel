# ADR 006 - Open core under AGPL-3.0, DCO instead of CLA, trademark reserved

- **Status**: accepted
- **Date**: 2026-10-21

## Context

Mycel is built by Bureau Bolster, which will also host it as a service. The platform should be genuinely open source (an argument for the non-profits and public bodies it serves, and the tech-principles ladder: self-hosted open source over SaaS), while not handing a competing hoster a free product. The licence also decides how contributions are accepted and whether later relicensing is possible.

## Decision

1. **Licence: GNU AGPL-3.0-only** for everything in this repository. Anyone may run, modify and self-host it; anyone who offers a modified version as a network service must publish their modifications. Non-profits and self-hosters are unaffected; competing hosters are not prevented, only obliged to share.
2. **Open-core boundary is the repository boundary.** Public (this repo): domain core, database adapter, HTTP API, MCP server, web app (admin and public rendering), forms, donation ledger, mailing, supporter registry, the Mollie and TEM adapters, documentation and ADRs. Private (other repos): fleet provisioning and operations, billing integration with the bookkeeping system, client dossiers and client-specific skills, hosting prices, the planning sibling.
3. **Private components talk to the public ones only through the HTTP API or MCP, never by importing them.** AGPL code must not be linked into proprietary code in one process; the ADR 001 architecture makes this free.
4. **Contributions under the Developer Certificate of Origin (DCO)**: every commit carries `Signed-off-by`. No Contributor Licence Agreement. Relicensing later is possible only with the consent of all contributors, which is intended: it keeps the AGPL promise credible.
5. **The name "Mycel", its logo and the hosted-service branding are not licensed under the AGPL.** `TRADEMARK.md` states what forks may and may not call themselves. (The working name may still change; the policy will not.)
6. **Dependencies must be licence-compatible with AGPL-3.0**: MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, GPL-3.0-compatible. No SSPL, BSL, "fair source" or proprietary SDK in the public packages. `npm run lint:deps` checks this on top of the dependency-direction rules.

## Rejected alternatives

- **MIT / Apache-2.0**: maximal adoption, but a hoster can productise the core without giving anything back. Right for a library, wrong for a platform we host commercially.
- **BSL / SSPL / Fair Source**: stronger protection, but not open source by the OSI definition, which weakens the argument towards public bodies and discourages contributors. If AGPL ever proves insufficient, that is a new ADR, not a quiet relicense.
- **CLA**: keeps relicensing open and is standard at VC-backed open-core companies. For a project whose code is written almost entirely by the maintainer and their agents, the friction buys nothing and the asymmetry costs trust.

## Consequences

- `LICENSE` is the AGPL-3.0 text; every package.json declares `AGPL-3.0-only`.
- `CONTRIBUTING.md` explains the DCO and the `-s` flag; CI checks for `Signed-off-by` once the repo is public.
- The repository can be public from the first commit: it contains no client data, no secrets, no prices.
