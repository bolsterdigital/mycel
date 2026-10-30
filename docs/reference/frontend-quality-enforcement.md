# Requiring the frontend quality check

The stable `frontend-quality` job validates all expected shards from the versioned matrix and corpus with the same consumer used for retained history. Trusting observation-job colour was rejected: measurement steps deliberately preserve non-pass scores during calibration. The job runs with `always()` after prepare and measure. It rejects missing/empty/corrupt/duplicate artifacts or cells, mismatched SHA/corpus/tools, missing samples, interrupted reports, failed downloads, and failed/cancelled/skipped upstream jobs even during calibration. Each new summary carries its GitHub run id and attempt; a retained earlier attempt cannot fill a missing shard. Every batch remains in the aggregate evidence. Cancelled entire workflows cannot supply a successful required check.

`quality-gate-<attempt>` retains sanitized JSON and Markdown for 90 days. Existing raw/encrypted/summary artifacts, observation statuses and baseline handling remain. Applicable measured `fail`, `inconclusive` and `not-measured` stay visible during calibration and block from the deadline in `scripts/quality/enforcement.json`. That deadline is suspended (`null`) since 2026-10-27 until the product matrix has been fully green once; see [the runner reference](frontend-quality-runner.md#calibration-and-enforcement). No prepared empty matrix can succeed. Full schedule/manual coverage still differs from the default PR/main set; neither a green PR set nor this gate certifies unimplemented preview, simulated-theme, manual or field coverage.

## Early activation

`scripts/quality/enforcement.json` holds the deadline (`null` while suspended). Earlier activation requires a reviewed change to `earlyActivation`, with this shape:

```json
{
  "at": "2026-11-02T12:00:00Z",
  "candidateSha": "<40 hexadecimal characters>",
  "fixtureHash": "<64 hexadecimal characters>",
  "runs": [
    "https://github.com/bolsterdigital/mycel/actions/runs/123",
    "https://github.com/bolsterdigital/mycel/actions/runs/456"
  ],
  "review": "https://github.com/bolsterdigital/mycel/pull/123#pullrequestreview-456"
}
```

These are illustrative ids, not evidence. The reviewer must independently inspect both distinct full workflowruns, exact measured candidate SHA, corpus hash, tool/runner profile, every applicable cell and five samples per cell, plus negative evaluator tests. Duplicate ids and invalid records fail closed. A syntactically valid record alone cannot establish green evidence. CI never writes or automatically enables this record. The deadline cannot be extended by this file.

## Reviewable protection request

[main-protection.json](../../.github/main-protection.json) is the exact proposed REST request for `main`. It is data for an authorized operator, never a CI step. On 2026-10-27 the protection GET returned 404 `Branch not protected`, rulesets GET returned `[]`, repository permissions reported `admin: true`. The main check-runs endpoint identified app **15368**, slug **github-actions**, for verify, security, image, compose, prepare and the two public nl measure jobs. There was no separate commit status or DCO app: the DCO step is inside required `verify`. The proposal requires those seven PR checks plus `frontend-quality`, all pinned to that app. The `observe` watchdog check was deliberately not required (decision of 2026-10-27): it judged the repository's Actions history rather than the diff, so a red scheduled run could block an unrelated PR, including one from a fork. Since 2026-10-27 the watchdog workflow no longer lives in this repository; it observes the measured workflow from the owner's private process tooling and reports there.

The proposal requires a pull request, resolved conversations and linear history. It no longer requires an up-to-date branch: since 2026-10-28 a merge queue on `main`, configured as the repository ruleset in [main-ruleset.json](../../.github/main-ruleset.json), tests every PR on the current `main` with the same eight checks (squash, one PR per group, no bypass actors) and merges only when they are green. `strict` without a queue was rejected because two streams of work merging independently left every open PR behind after each merge. A merger enqueues the reviewed head with the GraphQL mutation `enqueuePullRequest(pullRequestId, expectedHeadOid: <sha>)` and waits for `MERGED` or a removal from the queue; a PR whose combination with `main` fails drops out of the queue and is repaired on its own branch. Both layers are live and GitHub applies the stricter of the two: the ruleset adds the queue and leaves `required_review_thread_resolution` and `dismiss_stale_reviews_on_push` off, while the branch protection keeps `required_conversation_resolution` and `dismiss_stale_reviews` on (read back on 2026-10-30), so unresolved review threads and stale approvals still block a merge. It sets the GitHub approval count to zero and last-push approval to false because independent agent sessions share the owner's GitHub identity. The non-null review configuration retains the pull-request requirement; it does not enforce agent independence. It applies to admins, prohibits force pushes/deletion and supplies no review bypass users/teams/apps. No push restriction limits who may propose work. Repository/organization owners with Administration permission can still edit protection itself; this is not an immutable external control. Organization rulesets may add restrictions, so read them again immediately before activation.

Independent review follows [the agent review contract](../architecture/review.md): a separate session with fresh context records its verdict on the exact SHA, including as a COMMENT under the owner's shared GitHub identity. A separate merger verifies that record and the unchanged head. Requiring another GitHub account was rejected because it substitutes account separation for session independence and blocks the single-owner workflow. Do not bypass required CI checks or admin enforcement. Record any organization-level bypass behaviour and distinguish GitHub-enforced checks from the procedural agent-review requirement.

## Activation by the separate merger

Only after independent flagship approval of the exact PR SHA may the separate workhorse merger perform administration. Re-read protection, rulesets and actual check apps/names first. If protection changed since the review, reconcile without dropping any existing requirement; do not blindly replace a newer configuration. Apply the reviewed request when ready to merge this reviewed change, then read back its effective settings:

```sh
gh api repos/bolsterdigital/mycel/branches/main/protection
gh api repos/bolsterdigital/mycel/rulesets
gh api --method PUT repos/bolsterdigital/mycel/branches/main/protection --input .github/main-protection.json
gh api repos/bolsterdigital/mycel/branches/main/protection
gh api repos/bolsterdigital/mycel/rules/branches/main
```

The endpoint needs repository **Administration: write** and an admin/owner actor ([GitHub REST contract](https://docs.github.com/en/rest/branches/branch-protection)). Never give that credential to Actions. A 403, unavailable permission or unsupported protection feature leaves C3 open: record endpoint, response code, missing permission and the concrete action for repository owner Jaap Stronks. A read reporting admin access is not proof that the PUT is permitted.

After activation, open a disposable PR from current main whose sole intended effect is a failed `frontend-quality` check, for example prefix only the gate validation command in the disposable workflow with `QUALITY_DOWNLOAD_OUTCOME=failure`. This injects missing-download evidence into the real gate while leaving product code, the enforcement policy and the other required checks intact. An invalid policy file is unsuitable for this isolated proof because the existing policy tests would also make `verify` fail. Record SHA, workflow URL, check app/name/conclusion, GraphQL `mergeStateStatus: BLOCKED`, effective required contexts and approval state. Confirm no GitHub approval requirement blocks the PR and keep every other required check green, so missing reviews or another failing check cannot masquerade as the quality block. The disposable PR is never eligible for merge and needs no GitHub APPROVE; the separate reviewer checks the retained negative evidence. The gate rejects the injected missing-download evidence even before the deadline. Never attempt the merge. Close the PR and delete its branch after archiving proof. Admin merge ability is not the negative proof. Keep C3 open until read-back and this isolated rejection are established.

Two independent full green workflowruns on the same candidate remain an additional closure condition for the whole quality cycle. Deadline activation does not imply green product scores, resolve existing product repair addresses or establish schedule liveness.
