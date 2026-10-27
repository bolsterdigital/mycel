// Reuse the retained-report validator instead of trusting observation job colour. The gate
// binds every report to this attempt; artifacts from an earlier rerun cannot fill a hole.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumeRun, sourceContract } from './consume.mjs';
import { matrix } from './matrix.mjs';

export function enforcement(policy, now) {
  if (policy.deadline !== '2026-11-09T00:00:00Z' || !Number.isFinite(Date.parse(now)))
    throw new Error('invalid-enforcement-policy-or-clock');
  const early = policy.earlyActivation;
  if (early !== null) {
    if (
      !early ||
      !Number.isFinite(Date.parse(early.at)) ||
      Date.parse(early.at) >= Date.parse(policy.deadline) ||
      !/^[a-f0-9]{40}$/.test(early.candidateSha) ||
      !/^[a-f0-9]{64}$/.test(early.fixtureHash) ||
      !Array.isArray(early.runs) ||
      early.runs.length !== 2 ||
      new Set(early.runs).size !== 2 ||
      !early.runs.every((url) =>
        /^https:\/\/github.com\/bolsterdigital\/mycel\/actions\/runs\/\d+$/.test(url)
      ) ||
      !/^https:\/\/github.com\/bolsterdigital\/mycel\/pull\/\d+#pullrequestreview-\d+$/.test(
        early.review
      )
    )
      throw new Error('invalid-early-activation-record');
  }
  return Date.parse(now) >= Date.parse(early?.at ?? policy.deadline);
}

export function gate({ run, load, needs, downloadOutcome, policy, now }) {
  const enforced = enforcement(policy, now);
  const issues = [];
  if (downloadOutcome !== 'success') issues.push('artifact-download-non-success');
  if (!['push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(run.event))
    issues.push('unsupported-event');
  if (needs.prepare?.result !== 'success' || needs.measure?.result !== 'success')
    issues.push('prepare-or-measure-non-success');
  try {
    if (
      JSON.stringify(JSON.parse(needs.prepare.outputs.matrix)) !== JSON.stringify(matrix(run.event))
    )
      issues.push('unexpected-prepared-matrix');
  } catch {
    issues.push('missing-prepared-matrix');
  }
  const report = consumeRun({ ...run, status: 'completed', conclusion: 'success' }, (artifact) => {
    const summary = load(artifact);
    if (
      summary.workflow?.runId !== String(run.id) ||
      summary.workflow?.attempt !== String(run.attempt)
    )
      throw new Error('wrong-run-or-attempt');
    return summary;
  });
  issues.push(...report.issues.map((issue) => issue.reason));
  if (!report.expected || report.expected !== report.present) issues.push('incomplete-matrix');
  const measured = issues.length ? 'not-measured' : report.state;
  return {
    schemaVersion: 1,
    now,
    enforced,
    measured,
    // Broken evidence fails even during calibration. Actual measured non-pass stays visible
    // during calibration and blocks at the fixed deadline or registered early activation.
    blocks: issues.length > 0 || (enforced && measured !== 'pass'),
    issues: [...new Set(issues)],
    report,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const out = process.argv[3];
  const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const contract = sourceContract({
    corpus: source('apps/web/e2e/quality-corpus.json'),
    seed: source('scripts/e2e.mjs'),
    matrixSource: source('scripts/quality/matrix.mjs'),
    workflow: source('.github/workflows/frontend-quality.yml'),
    lock: source('package-lock.json'),
  });
  let artifacts = [];
  try {
    artifacts = readdirSync(root).map((name) => ({ name, path: join(root, name, 'summary.json') }));
  } catch {
    // No download is a missing matrix, never an empty successful set.
  }
  const result = gate({
    run: {
      id: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      event: process.env.GITHUB_EVENT_NAME,
      headSha: process.env.GITHUB_SHA,
      measuredSha: process.env.GITHUB_SHA,
      contract,
      artifacts,
    },
    load: (artifact) => JSON.parse(readFileSync(artifact.path, 'utf8')),
    needs: JSON.parse(process.env.QUALITY_NEEDS),
    downloadOutcome: process.env.QUALITY_DOWNLOAD_OUTCOME,
    policy: JSON.parse(readFileSync(new URL('./enforcement.json', import.meta.url), 'utf8')),
    now: new Date().toISOString(),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'summary.json'), JSON.stringify(result, null, 2));
  const text =
    `Frontend quality: **${result.measured}**. Enforced: **${result.enforced}**.\n\n` +
    `Cells: ${result.report.present}/${result.report.expected}. Samples: ${result.report.samples}.\n\n` +
    `Evidence issues: ${result.issues.join(', ') || 'none'}.\n`;
  writeFileSync(join(out, 'summary.md'), text);
  console.log(text);
  if (result.blocks) process.exitCode = 1;
}
