# Reproducing the factory report

The factory CLI derives process metrics from the [C1 history consumer](frontend-quality-runner.md#consuming-history-and-checking-missed-schedules). It has no planning credentials, database or independent storage service. Rejected: inferring closure from a green job or reading the private planning sibling in CI. The existing read-only watchdog publishes both C1 and factory JSON/Markdown as a 90-day artifact on its daily, PR and manual observations; the report includes the weekly due/overdue state. This does not prove an actual schedule firing or establish enforcement.

```sh
node scripts/quality/history.mjs --repo=bolsterdigital/mycel --run=40366473887 --out=.scratch/history-new
node scripts/quality/consume.mjs --input=.scratch/history-new --as-of=2026-10-27T13:00:00Z --out=.scratch/consumed-new
node scripts/quality/factory.mjs --input=.scratch/consumed-new/summary.json --closures=docs/reference/frontend-quality-closures.example.json --out=.scratch/factory-new
```

Use the actual UTC clock for `--as-of` and fresh output directories. Omit `--closures` when no sanitized human input is available; the report says `not-measured`. The example is an explicitly empty inventory, not a claim that no defects or exceptions exist. Keep real input outside git until it has been reviewed for publication. Historical summaries lack optional job timing and PR identity; those fields remain unknown. The history adapter now collects all quality attempts from 2026-10-26 00:00 UTC, the first CI observation date, including failed and cancelled attempts. The weekly activation clock remains separate.

## Counting rules

Each snapshot includes a trailing seven-day window (attempts, first-observed heads, supplied closures and known runner cost) and cumulative cohorts from the first observation. Weekly counts never replace retained earlier failures.

The population is all retained `pull_request` quality workflow heads from the observation date, including changes to quality policy. Heads are counted once, across routes, profiles, diagnostic batches and reruns. The first observed attempt's first batch determines first-pass status; a later pass cannot replace failure, inconclusive or missing first evidence. The denominator contains only heads whose first batch is structurally complete and pass/fail. Missing and inconclusive attempts and heads without a valid first batch are reported separately. As-of filtering uses attempt start time, so future reruns cannot alter an earlier report.

The first ten distinct PR identities form the first cohort; the next ten form the comparison cohort, ordered by first observation time, run id and attempt. Every head of an included PR remains in that cohort's numerator/denominator. When GitHub omits PR associations from completed run metadata, the adapter resolves commit-to-PR associations with an exact head-SHA match. Unknown or ambiguous PR identity stays visible and outside cohorts. Historical API/artifact retention limits completeness; the report never claims an exhaustive population. Before twenty distinct PRs exist, comparison stays pending. Afterwards it invites human bottleneck analysis and still makes no automatic improvement claim.

Job execution minutes sum each job's start/end duration, including parallel shards. They are neither wall time nor GitHub billed minutes. Unavailable or unfinished job durations remain missing, and the known sum is labelled partial. Workflow attempt reruns and per-cell diagnostic batches are separate counts. Repair calendar time and active repair minutes are separate; unknown active time is never zero. False alarms require supplied evidence and never mean all observed failures are noise.

## Sanitized closure input, schema version 1

The top-level object requires exactly `schemaVersion`, `closures`, `exceptions`, `falseAlarms` and `implementedRoutes`. All lists may be empty. Unknown properties are rejected, including private notes. Identifiers accept only bounded code identifiers, not prose or e-mail addresses. Evidence URLs must be GitHub action runs, PRs or immutable blob addresses, with no query string. Never place client information in identifiers or in linked public evidence.

Each closure requires these fields:

| Field                      | Meaning                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`, `address`, `owner`  | Existing C1 cause key, existing planning identifier and `dev` or `mbp`; no new ticket is created.                                                                                   |
| `defectSha`, `repairedSha` | Different full Git SHAs.                                                                                                                                                            |
| `environment`              | SHA-256 environment fingerprint from the factory report's `sources`; binds Node, Lighthouse, Playwright, Chromium, Caddy and runner image, separately from changed fixture content. |
| `detectedAt`, `repairedAt` | UTC ISO dates, in chronological order.                                                                                                                                              |
| `detectedAfterMerge`       | Explicit human confirmation that this defect escaped merge, not inferred from a push.                                                                                               |
| `activeRepairMinutes`      | Nonnegative measured minutes or `null`.                                                                                                                                             |
| `prevention`               | `null`, a gate record or a manual record below.                                                                                                                                     |

A gate prevention record has exactly `kind: "gate"`, `gate`, `red`, `green`, `missedGate` and `durableRule`. Red and green are distinct evidence URLs; the other fields identify the closest reusable gate, why its predecessor missed the class and the lasting rule or fixture. A manual prevention record has exactly `kind: "manual"`, `scenario`, `evidence` and `limitation`: identify a concrete retained scenario and observed evidence, with a bounded limitation identifier. The linked record carries the actual scenario and browser/assistive technology details.

The CLI verifies that the failing measured SHA, cause and environment exist in retained C1 history. It reports a closure as documented only with that match and prevention input. The linked green/red/manual outcomes remain human assertions; the CLI does not fetch or certify their contents. Invalid, absent or unmatched evidence cannot satisfy prevention coverage. Prevention completion is documented closures / all supplied closures, not a private-ledger completeness claim.

A later observation of the same cause and environment after `repairedAt`, on a SHA other than the defect SHA, becomes a recurrence proposal at the same address. It is deduplicated across routes and closure records. A later workflow may still measure older code: human ancestry/deduplication review is required before calling the proposal a confirmed recurrence. Escapes are reported by cause from source-matched, explicitly confirmed closure records only.

Exceptions require `id`, `cell`, `criterion`, `owner`, `address`, `expiresAt` and `decision` (evidence URL). Expiry at or before the report clock remains visible and never turns a red cell green. False alarms require `runId`, `attempt` and `evidence`; unknown run references do not count. Implemented route inventory requires `route`, `owner`, `address` and `source` (immutable implementation evidence or PR/run URL). Each entry is explicit required-coverage debt until an owning gate proves it; implementation is not inferred from a planned corpus row. C1 coverage observations and this inventory remain separate, with completeness unknown.

The existing quality runner suite tests first-batch and cohort counts, route deduplication, reruns, closure/environment provenance, recurrence, exceptions, missing time, job-minute aggregation and rejected private fields. Product repairs remain in their existing construction gates. This report cannot close preview, theme, manual, product or enforcement work.

## First retained snapshot

The [2026-10-27 snapshot](../reports/frontend-quality-factory-2026-10-27.md), [machine-readable report](../reports/frontend-quality-factory-2026-10-27.json) and [explicit sanitized input](../reports/frontend-quality-input-2026-10-27.json) retain 38 attempts at 13:10:57 UTC. First pass is 0/14 valid first-observed PR-head batches, with nine heads lacking a valid first batch and ten missing attempts. Seven PR identities are resolved; sixteen historical heads remain unassigned because the API cannot prove an exact current head association. Thus baseline progress is 7/10, with no comparison or improvement claim. The historical manual full matrix retains 36 cells/180 samples, eighteen fail. Known job execution cost is 536.07 runner minutes over 37 attempts; one attempt has unknown cost. No product closure or false-alarm completeness is asserted. Dynamic preview and the implemented information composition remain explicit coverage debt.
