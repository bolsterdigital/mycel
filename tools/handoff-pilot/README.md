# Mycel handoff pilot on one Mac

This local process supervisor follows the existing `mbp` handoff, with one fresh Codex thread per execution, independent review, merge and, when the shared drift threshold fires, audit. It does not schedule the entire roadmap. The current sample allowlist contains only `#44`: the current mbp queue does not offer two small, already briefed, startable items. `#44` is a substantial CMS shell task; completion of it would be a smaller pilot, not evidence of two completed items.

The supervisor is deliberately disarmed until its own code and permissions have passed independent flagship review. It uses `codex exec --sandbox workspace-write --approve-for-me` with the code repository and private planning sibling. It never disables signing, approval review, CI or branch protection. An automatic approval rejection stops the session. The [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes fresh `codex exec` threads, JSONL events and the structured final result. The installed CLI must also support `gh pr merge --match-head-commit`.

## Operate

```sh
node tools/handoff-pilot/cli.mjs dry-run tools/handoff-pilot/pilot.example.json
node tools/handoff-pilot/cli.mjs preflight tools/handoff-pilot/pilot.example.json
node tools/handoff-pilot/cli.mjs start tools/handoff-pilot/pilot.example.json
node tools/handoff-pilot/cli.mjs status
node tools/handoff-pilot/cli.mjs logs
node tools/handoff-pilot/cli.mjs logs --files
node tools/handoff-pilot/cli.mjs pause
node tools/handoff-pilot/cli.mjs resume
node tools/handoff-pilot/cli.mjs stop
```

`dry-run` reads Git, GitHub, model profile and planning without writing files or starting agents. `preflight` checks CLI login, GitHub push rights, published planning, tool availability and model access with short read-only probes. If `commit.gpgsign=true`, it runs a 15-second real `git commit-tree -S` probe without changing refs; a Touch ID requirement that cannot complete unattended is a stop. The probes are outside the bounded development chain and their output stays in the local state directory. A `start` requires a clean `main`, no existing claim or open PR on the allowlist and a preflight for the exact runner code and current head. The sample limit is eight chain sessions, two repairs per item and six hours. Stop kills the active agent process group; pause lets it finish but prevents the next launch. An interrupted session without a verifiable technical result blocks, rather than repeating a merge.

`MYCEL_PILOT_HOME` overrides the state and log directory, defaulting to `~/Library/Application Support/mycel-handoff-pilot`. `MYCEL_PILOT_PLANNING` overrides the sibling planning path. State, JSONL, stderr and structured results stay there with owner-only permissions, outside both Git repositories. Archive that directory before starting a new pilot. Status shows phase, item, model, PR, elapsed minutes, next action or stop reason and the number of recorded deviations. `logs` prints recent raw local events; review them for sensitive information before sharing. `pause` waits for supervisor acknowledgment and keeps the deadline monitor active for a running agent. `stop` waits for acknowledgment and child termination; if a launch was reserved when the supervisor vanished, it reports the uncertainty instead of claiming success.

## Activation record

After independent flagship review and merge of the runner PR, create `activation.json` in `MYCEL_PILOT_HOME` with `outcome`, `runnerPr`, `approvedHeadSha`, `mergedSha`, `codeDigest`, `authorSessionId`, `reviewSessionId`, `reviewRecord` and `planningCommit`. `reviewRecord` is a path beneath `reference/` in private planning. The record must name the exact approved runner head and review session. `codeDigest` is the SHA-256 over `cli.mjs`, `state.mjs` and `result.schema.json` in that order. The runner verifies the published review record, distinct sessions, four green CI jobs, GitHub's merged PR and the current `main` commit before starting. Run preflight _after_ the merge; the preflight and activation record must both match that code digest. Keep the review record in private planning and do not treat a local activation file alone as approval.

## Evidence and recovery

Each agent returns a schema-checked technical result with run and reserved session IDs, item, lane, phase, PR, head SHA, planning commit, outcome and evaluation observations. The supervisor additionally reads the actual Codex thread ID from JSONL. Before every next launch it checks GitHub's PR/head/merge/CI state, published planning and the normal mbp handoff. Review approval is pinned to the PR head; a changed head sends work back for independent review. Merge uses `--match-head-commit`. After merge, the published housekeeping commit must touch TODO, done register, drift log and the next handoff; the drift log must name the PR. At a drift threshold the merge session registers the shared task, then a separate audit session claims it atomically before working. If dev owns the task, mbp proceeds with its own lane.

On crash, `resume` inspects the saved reservation and child process. If the child finished, it validates the saved result against GitHub and Git before advancing. It never replays an already verified merge. A reservation with no result, invalid handoff, stale approval or exhausted limit blocks and needs manual inspection of `status`, logs and external systems before a new run. Do not edit state to force a transition. Use a new bounded pilot after repairing the cause and preserving the previous logs. `stop` ends a run permanently.

## Evaluation

Every session reports deviations with expected criterion, observation, detection, repair, suspected cause, prevention address and evidence. These are persisted alongside immutable session events but have no authority to pass a gate. During and after the pilot, reconcile these observations against [the evaluation brief](../../docs/plans/briefs/handoff-pilot-evaluation.md): whether the cause belongs in a planning brief, an existing conformance test, review criteria, a skill or runner infrastructure. Record the actual edit and a counterexample that would have failed before it. A clean run is not the goal; detecting and preventing repeatable drift is.

Moving the runner to dev-server-1 is separate work. It requires path and CLI checks there, a new unattended signing probe, lane ownership and conflict review, and another independent activation review. No second-machine coordinator is included here.
