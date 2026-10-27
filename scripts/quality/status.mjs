// Observation never rewrites a failed score to pass. At the fixed deadline the job blocks,
// even if calibration has unresolved defects; branch protection is separately verified.
import { readFileSync } from 'node:fs';
export function status(report, outcome, today = new Date().toISOString().slice(0, 10)) {
  const deadline = '2026-11-09';
  const valid =
    report &&
    report.cells?.length &&
    !report.error &&
    outcome === 'success' &&
    report.state === 'pass';
  return {
    measured: report?.state ?? 'not-measured',
    enforcementDue: today >= deadline,
    blocks: !valid && today >= deadline,
    deadline,
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
  console.log(`Lighthouse: **${result.measured}**. Calibration deadline: ${result.deadline}.`);
  if (report)
    console.log(
      `SHA: ${report.commit}. Cells: ${report.cells.length}. Runner minutes: ${report.durationMinutes?.toFixed(2)}. Repair proposals are in summary.json.`
    );
  else
    console.log(
      'Missing measurement: dev owns #43C-report (historical alias #43B). Inspect the measurement step and missing artifact.'
    );
  if (result.blocks || !report) process.exitCode = 1;
}
