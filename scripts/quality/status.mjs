// Observation never rewrites a failed score to pass. Once enforcement.json applies the job
// blocks, even if calibration has unresolved defects; branch protection is separately verified.
// The deadline is read from the policy (see gate.mjs); a hardcoded copy was rejected because it
// drifted from the policy the required gate uses.
import { readFileSync } from 'node:fs';
import { enforcement } from './gate.mjs';
const committedPolicy = () =>
  JSON.parse(readFileSync(new URL('./enforcement.json', import.meta.url), 'utf8'));
export function status(
  report,
  outcome,
  now = new Date().toISOString(),
  policy = committedPolicy(),
  repository = process.env.GITHUB_REPOSITORY
) {
  const due = enforcement(policy, now, repository);
  const valid =
    report &&
    report.cells?.length &&
    !report.error &&
    outcome === 'success' &&
    report.state === 'pass';
  return {
    measured: report?.state ?? 'not-measured',
    enforcementDue: due,
    blocks: !valid && due,
    deadline: policy.deadline,
  };
}
if (process.argv[1]?.endsWith('/status.mjs')) {
  let report;
  try {
    report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  } catch {
    /* Missing report remains missing. */
  }
  const result = status(report, process.env.MEASUREMENT_OUTCOME);
  console.log(
    `Lighthouse: **${result.measured}**. Enforcement deadline: ${result.deadline ?? 'suspended (not set)'}.`
  );
  if (report)
    console.log(
      `SHA: ${report.commit}. Cells: ${report.cells.length}. Runner minutes: ${report.durationMinutes?.toFixed(2)}. Repair proposals are in summary.json.`
    );
  else
    console.log(
      'Missing measurement. Inspect the measurement step and the missing artifact; the retained history routes it.'
    );
  if (result.blocks || !report) process.exitCode = 1;
}
