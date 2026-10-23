# Targeted review

Every pull request already gets an independent review (the author never merges their own PR) and `npm run verify` as the gate ([testing.md](testing.md)). This document adds one thing: a way to decide, per PR, whether the gate already proves the behaviour that changed, and if not, which **one** extra counterproof is worth twenty to thirty minutes. A cheap, deterministic step proposes; the reviewer chooses; every piece of evidence hangs on a claim, a SHA and an owner.

Rejected: a fixed set of reviewer agents per PR (expensive, mostly duplicates of what the conformance suites already prove), a numeric risk score (false precision: a path list cannot see that a cache change breaks a form post), and periodic broad audits after every N merges (they mix progress, architecture, code and a moving CI state into one report nobody can repeat). The broad check of 2026-10-23 was useful for finding chains of defects; it was not a unit worth repeating.

## The record

A targeted review writes six fields. Without them a finding is a hypothesis.

1. **Behaviour claim**: what the PR says now holds, in one sentence ("a cached page older than 24 hours still yields a valid form POST").
2. **Touched surface**: the paths, plus their direct dependents that are not in the diff (a changed use case changes HTTP, OpenAPI and MCP at once).
3. **Failure case**: the concrete input or state under which the claim would be false.
4. **Existing evidence**: the gate, suite or CI run that already proves it, on which SHA.
5. **Smallest counterproof**: the cheapest test that would show the failure case, if 4 is not enough.
6. **Decision**: `gate suffices` | `counterproof run: <outcome>` | `needs review` | `finding at <address>`.

An outcome names the file and state, the SHA, what was actually executed (not what was read), and where the repair lands. "Looks fine" is not an outcome.

## Lenses

One method, eight questions. The catalogue is a menu, not a checklist: a review picks at most one lens beyond the mandatory one, on plausible damage and uncertainty, for what the gate does not already prove. Several critical boundaries in one PR may get several specific counterproofs. Anyone can invoke any lens by hand at any time; nothing waits for a counter.

| Lens           | Question                                                                                                                                | Status    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `security`     | Can an unauthorised principal read or do something; do consent, erasure, export and the organisation's control stay intact?             | mandatory |
| `domain`       | Do an editor and a visitor understand the content types, sections, labels and navigation; do publication and findability stay coherent? | manual    |
| `contract`     | Do HTTP, OpenAPI and MCP mean the same use case and capability; is an external consumer still compatible?                               | pilot     |
| `frontend`     | Does the real task path work without JavaScript where required, with a keyboard, at 320 px and at 200 % zoom?                           | manual    |
| `locale`       | Are locale readiness, translated fields, canonical, feeds and cache right for every representation of the same content?                 | manual    |
| `reliability`  | What happens under concurrency, on retry, when a provider fails, in a backup and in a restore after an erasure?                         | pilot     |
| `architecture` | Does the core stay free of I/O; does a new abstraction demonstrably remove duplicated work; does a removal keep behaviour?              | pilot     |
| `process`      | Do brief dependencies, delivered claims and regression evidence hold; is an extra gate still earning its place?                         | manual    |

Statuses: **mandatory** is checked in every review and is never the optional extra; **pilot** lenses are the ones the signals may propose during the current pilot; **manual** lenses exist and are invoked on request; **inactive** marks a surface that is not built yet (the editor, once ADR 020 ships, starts there). Public values are testable behaviour here, not a sentiment: a tenant can export its data, consent is checked at the moment of use, an agent gets no more capability than the UI, accessible HTML and open formats are product properties (ADR 002, 009, 018).

The lens questions, the paths each one watches, the ADRs and gates that already cover it, and its smallest counterproof live in [`review-profile.json`](review-profile.json). That file is the **project profile**: data, so another project can carry its own without forking this method, and so a test can keep it honest.

## Signals

```sh
node scripts/review-signals.mjs                     # origin/main...HEAD
node scripts/review-signals.mjs --base main --head feat/x --json
```

The script maps the changed files through the profile and prints, in a block that goes into the review record or the PR body:

- the lenses the diff touches, mandatory first, with their gates and counterproof;
- **flags** the reviewer reads before the code: `migration`, `test-surface`, `adr`, `registry`, `ci`, `env`;
- **unmapped** files the profile does not know. The verdict is then `needs review`, never a silent pass; map the path or judge it by hand;
- files that change no behaviour (documentation, reports).

It chooses nothing and it does not look at CI: a green check counts only on the exact SHA under review, and the reviewer looks that up. Local green with another database, Chromium or tenant fixture proves that environment, not this one.

The `test-surface` flag is the cheap form of a holdout: tests and fixtures are the part of the repository a change must not quietly bend to itself. A weaker assertion, a new skip or a regenerated snapshot is read first and needs its reason in the PR ([testing.md](testing.md) rule 5), and the generic suites are meant to grow from fixtures, not to be edited per feature.

`scripts/review-signals.test.mjs` (in `npm run lint:infra`) fails when a path pattern matches no tracked file, when a gate or ADR the profile names does not exist, or when a lens lacks a field. The review method is held to the same standard as the code: a rule that cannot rot silently.

## Evidence

- Evidence is reusable only for the **same code, environment and scope**: repo, base and head SHA, lens, profile version, touched dependencies, kind of evidence, outcome. CI on the same SHA is evidence; a run on an earlier SHA is history.
- If `main` moves during a review, refresh the touched claim and its dependencies; do not re-prove the whole new `main`, and say what stayed out of view.
- A model finding is a hypothesis until a path, a state and a reproducible counterproof carry it. An unknown dependency or an unclear provenance of the evidence gives `needs review`, not `pass`.
- Every finding gets **one existing address** in the planning (a TODO item or a brief), deduplicated on cause and failure case; two findings with one cause are one item. A security finding is raised even when an item ceiling is reached.
- A defect that keeps appearing on one invariant goes back into the **right existing conformance or regression gate**, not into a new generic test layer. A form token that expires wants a test with elapsed time, a conditional GET and a real POST, not another HTML snapshot; an erasure that must survive a restore wants the window before the next backup in the drill.
- A defect found **after** the merge is an escape. It is recorded with its class and the gate or rule that now catches that class, so the repair is to the machine, not only to the output. Flaky tests are fixed or removed the same day (testing.md rule 6).
- Pruning carries the same burden as adding: name the call sites, duplicated lines or dead abstraction removed, show behaviour kept, count the exceptions introduced. Lines of code are not a quota; explicit code can be cheaper than a short generic layer.

## Budget

- The signals run in every review. During the pilot (see below) the lens choice is recorded first as a shadow: which lens the signals propose, which the reviewer would choose, which existing gate already covers it, and how many minutes finding the evidence took.
- At most **one** extra targeted review per PR, twenty to thirty minutes, with the failure question written down before it starts. Security and consent are part of every review, not of this budget.
- When CI is red or a claim is already open, no optional investigation starts that grows the stock. Looking into the red CI itself and raising an urgent security finding are direct work.
- No automatic fix, PR or merge comes out of a targeted review. Findings land at an address; a session that starts from that address repairs.

## The pilot

The method starts as a bounded experiment in this repository, registered in the private planning sibling (`docs/plans/reference/review-pilot-2026-10.md`): shadow routing on ordinary reviews, three pilot lenses (`reliability`, `architecture`, `contract`), at most two extra targeted reviews in the whole window, and a written decision at the end. Measured: minutes and model used, confirmed new findings against duplicates and unusable ones, open stock, delayed repairs, escapes, flakiness. The numbers are working budgets, not proven thresholds or release conditions. If the evidence is thin, the automatic part stays off and nothing expands; that says nothing about the value of a lens invoked by hand. If it is convincing, one contrasting repository tries the same record and signals with its own small profile, so the method is tested for reuse without copying this project's assumptions.

## Changing the profile

Edit the JSON; the test tells you what broke. A path that keeps turning up as `unmapped` belongs in a lens. A new lens needs all eight fields and starts as `manual`; it becomes `pilot` only through a pilot decision. A gate added to a lens is one that exists and runs in `verify` or in CI, not one that is planned.
