---
name: mycel-frontend-quality
description: Apply Mycel's measurable frontend quality contract when planning or changing public pages, editor UI, themes, blocks, assets or integrations, or triaging Lighthouse and accessibility regressions. Route measured defects into existing conformance gates and bounded repair work.
---

# Mycel frontend quality

Read [the quality contract](../../../docs/architecture/frontend-quality.md) for thresholds, measurement protocol, rollout status and repair routing. It is authoritative; this skill does not duplicate its budgets. Read the repository's testing and review instructions too.

Before a frontend change, identify the route, locale, state, fixture and criterion affected. Reuse the registry examples and campaign/journalism flows. New component variants need representative fixtures before implementation; new routes need measurement coverage before delivery. Do not treat an unimplemented gate or missing report as a pass.

For a quality run, establish the code SHA, fixture hash, browser/Lighthouse versions and runner profile. Measure the production build with the prescribed repetitions. Inspect page identity and resource loading before interpreting scores. Preserve every sample, including failures; distinguish `pass`, `fail`, `inconclusive` and `not-measured`. Never substitute a login page, strip representative content, disable security or consent controls, select the best run, or weaken thresholds to obtain 100.

For a failure, use the contract's triage table and the repository's six-field review record. Reproduce the smallest failure, deduplicate against existing planning, then give each independent cause one owner, failing fixture and acceptance test. Start no more than three independent repair tracks at once. Respect lane ownership, branch claims and independent review; a review session records the repair address and does not repair its own finding. A pipeline may emit proposals but cannot silently rewrite private planning or launch unbounded agent work.

A repair must improve the factory: demonstrate red before and green after in the closest existing generic suite, shared component, schema or asset pipeline. Record why the previous gate missed it. Do not add a generic test framework, global skill rule or repetitive per-page tests when one shared fixture catches the class. Accessibility defects requiring human judgement retain a precise manual scenario, browser/assistive-technology versions and observed outcome.

Report the measured outcome and limits, the repair address when needed, and what now prevents recurrence. Preserve unrelated handoff assignments. The score is a retained safety net; reduced repair work is the process improvement, not permission to remove the checks.
