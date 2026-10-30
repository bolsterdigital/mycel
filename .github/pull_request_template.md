<!-- Title: conventional commit, written for someone who runs Mycel (CONTRIBUTING.md § Pull requests). -->

**Item or brief.** TODO #… / brief `…` (private planning). Deviations from the brief, numbered, with the reason.

**Behaviour claim.** One sentence: what holds now that did not before.

**Evidence** (docs/architecture/testing.md § What a PR needs):

- Conformance suite that grew, or why none did:
- Hand-written invariants added:
- Could not be run locally:
- Snapshot updated, and why:
- UI with two or more actions: screenshots at 320 px and at 200 % zoom, attached to this PR (never committed; `scripts/gates/repo-size.test.mjs` rejects files over 200 KB):

**Review signals** (`node scripts/review-signals.mjs`, paste the block; `unmapped` paths are mapped or explained):

**Out of scope, noticed on the way.** One line each, no changes made.
