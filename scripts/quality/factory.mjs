// Derive process evidence from C1's retained history, not a second ledger or job colours.
// Human closure is explicit, allowlisted input; unknown effort and prevention stay unknown.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const start = '2026-10-26T00:00:00Z';
const date = (v) =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v));
const id = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:#/+-]{1,200}$/.test(v);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const link = (v) =>
  typeof v === 'string' &&
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:actions\/runs\/\d+(?:\/attempts\/\d+)?|pull\/\d+|blob\/[a-f0-9]{40}\/[\w./-]+)(?:#[-\w]+)?$/.test(
    v
  );
const minutes = (v) => v === null || (Number.isFinite(v) && v >= 0);
const measured = (value) => (value === null ? 'not-measured' : value);
function shape(value, fields, required = fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k)) ||
    required.some((k) => !(k in value))
  )
    throw new Error('Invalid sanitized factory input shape');
}
function requireFields(value, checks) {
  for (const [field, check] of Object.entries(checks))
    if (!check(value[field])) throw new Error(`Invalid sanitized factory field: ${field}`);
}
export function environmentKey(run) {
  return run.tools
    ? createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              ['node', 'lighthouse', 'playwright', 'chromium', 'caddy', 'runner'].map((k) => [
                k,
                run.tools[k],
              ])
            )
          )
        )
        .digest('hex')
    : null;
}
// No free-form notes, HTML, recipient data or arbitrary URLs cross this publication boundary.
export function closureInput(input) {
  shape(input, ['schemaVersion', 'closures', 'exceptions', 'falseAlarms', 'implementedRoutes']);
  if (
    input.schemaVersion !== 1 ||
    ['closures', 'exceptions', 'falseAlarms', 'implementedRoutes'].some(
      (k) => !Array.isArray(input[k])
    )
  )
    throw new Error('Unsupported factory input');
  const unique = new Set();
  for (const c of input.closures) {
    shape(c, [
      'key',
      'address',
      'owner',
      'defectSha',
      'repairedSha',
      'environment',
      'detectedAt',
      'repairedAt',
      'detectedAfterMerge',
      'activeRepairMinutes',
      'prevention',
    ]);
    requireFields(c, {
      key: id,
      address: id,
      owner: (v) => ['dev', 'mbp'].includes(v),
      defectSha: sha,
      repairedSha: sha,
      environment: digest,
      detectedAt: date,
      repairedAt: date,
      detectedAfterMerge: (v) => typeof v === 'boolean',
      activeRepairMinutes: minutes,
    });
    if (
      Date.parse(c.repairedAt) < Date.parse(c.detectedAt) ||
      c.defectSha === c.repairedSha ||
      unique.has(`${c.key}:${c.repairedSha}`)
    )
      throw new Error('Invalid closure chronology or duplicate');
    unique.add(`${c.key}:${c.repairedSha}`);
    if (c.prevention !== null) {
      const p = c.prevention;
      if (p.kind === 'gate') {
        shape(p, ['kind', 'gate', 'red', 'green', 'missedGate', 'durableRule']);
        requireFields(p, { gate: id, red: link, green: link, missedGate: id, durableRule: id });
        if (p.red === p.green) throw new Error('Red and green evidence must be distinct');
      } else {
        shape(p, ['kind', 'scenario', 'evidence', 'limitation']);
        requireFields(p, {
          kind: (v) => v === 'manual',
          scenario: id,
          evidence: link,
          limitation: id,
        });
      }
    }
  }
  for (const e of input.exceptions) {
    shape(e, ['id', 'cell', 'criterion', 'owner', 'address', 'expiresAt', 'decision']);
    requireFields(e, {
      id,
      cell: id,
      criterion: id,
      owner: (v) => ['dev', 'mbp'].includes(v),
      address: id,
      expiresAt: date,
      decision: link,
    });
  }
  for (const f of input.falseAlarms) {
    shape(f, ['runId', 'attempt', 'evidence']);
    requireFields(f, {
      runId: (v) => Number.isSafeInteger(v) && v > 0,
      attempt: (v) => Number.isSafeInteger(v) && v > 0,
      evidence: link,
    });
  }
  for (const r of input.implementedRoutes) {
    shape(r, ['route', 'owner', 'address', 'source']);
    requireFields(r, {
      route: id,
      owner: (v) => ['dev', 'mbp'].includes(v),
      address: id,
      source: link,
    });
  }
  return structuredClone(input);
}
const empty = () => ({
  schemaVersion: 1,
  closures: [],
  exceptions: [],
  falseAlarms: [],
  implementedRoutes: [],
});
function firstBatch(run) {
  if (
    run.present !== run.expected ||
    !run.expected ||
    run.issues.some((i) => i.reason !== 'run-unsuccessful')
  )
    return 'not-measured';
  const states = run.cells.map((c) => c.batches[0].state);
  if (states.includes('not-measured')) return 'not-measured';
  if (states.includes('inconclusive')) return 'inconclusive';
  return states.includes('fail') ? 'fail' : 'pass';
}
export function factory(report, input = null) {
  if (report.schemaVersion !== 1 || !date(report.asOf)) throw new Error('Invalid C1 report');
  const human = closureInput(input ?? empty());
  const asOf = Date.parse(report.asOf);
  const runs = report.runs
    .filter((r) => date(r.startedAt) && Date.parse(r.startedAt) <= asOf)
    .sort(
      (a, b) =>
        Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id - b.id || a.attempt - b.attempt
    );
  const prRuns = runs.filter(
    (r) => r.event === 'pull_request' && Date.parse(r.createdAt) >= Date.parse(start)
  );
  const heads = new Map();
  for (const run of prRuns) {
    const entry = heads.get(run.headSha) ?? {
      headSha: run.headSha,
      pullRequests: [],
      firstObservedAt: run.startedAt,
      attempts: [],
      firstValid: null,
      firstResult: null,
    };
    entry.pullRequests = [...new Set([...entry.pullRequests, ...(run.pullRequests ?? [])])];
    const state = firstBatch(run);
    const ref = { id: run.id, attempt: run.attempt, url: run.url, state };
    entry.attempts.push(ref);
    // The first observed batch is immutable, including missing/inconclusive first evidence.
    if (!entry.firstResult) {
      entry.firstResult = ref;
      if (['pass', 'fail'].includes(state)) entry.firstValid = ref;
    }
    heads.set(run.headSha, entry);
  }
  const headList = [...heads.values()];
  const valid = headList.filter((h) => h.firstValid);
  const prs = new Map();
  for (const head of headList) {
    if (head.pullRequests.length !== 1) continue;
    const number = head.pullRequests[0];
    if (!prs.has(number))
      prs.set(number, { number, firstObservedAt: head.firstObservedAt, heads: [] });
    prs.get(number).heads.push(head.headSha);
  }
  const batches = [0, 10].map((offset) => {
    const entries = [...prs.values()].slice(offset, offset + 10);
    const batchHeads = headList.filter((h) => entries.some((p) => p.heads.includes(h.headSha)));
    return {
      progress: entries.length,
      target: 10,
      pullRequests: entries,
      numerator: batchHeads.filter((h) => h.firstValid?.state === 'pass').length,
      denominator: batchHeads.filter((h) => h.firstValid).length,
    };
  });
  const closures = human.closures
    .filter((c) => Date.parse(c.repairedAt) <= asOf)
    .map((c) => {
      const defect = runs.find(
        (r) =>
          r.measuredSha === c.defectSha &&
          environmentKey(r) === c.environment &&
          r.proposals.some((p) => p.key === c.key)
      );
      const recurrence = runs.filter(
        (r) =>
          r.measuredSha !== c.defectSha &&
          Date.parse(r.startedAt) > Date.parse(c.repairedAt) &&
          environmentKey(r) === c.environment &&
          r.proposals.some((p) => p.key === c.key)
      );
      return {
        ...c,
        sourceVerified: Boolean(defect),
        preventionState: defect && c.prevention ? 'documented' : 'not-measured',
        calendarMinutes: (Date.parse(c.repairedAt) - Date.parse(c.detectedAt)) / 60000,
        activeRepairMinutes: measured(c.activeRepairMinutes),
        recurrence: [
          ...new Map(
            recurrence.map((r) => [
              `${r.id}:${r.attempt}`,
              { id: r.id, attempt: r.attempt, url: r.url, measuredSha: r.measuredSha },
            ])
          ).values(),
        ],
        recurrenceStatus: 'proposal-requires-human-confirmation',
      };
    });
  const causes = [...new Set(closures.map((c) => c.key))].map((key) => ({
    key,
    escapes: closures.filter((c) => c.key === key && c.detectedAfterMerge && c.sourceVerified)
      .length,
    recurrence: closures
      .filter((c) => c.key === key)
      .flatMap((c) => c.recurrence)
      .filter((r, i, all) => all.findIndex((x) => x.id === r.id && x.attempt === r.attempt) === i),
    address: closures.find((c) => c.key === key).address,
  }));
  const coverage = [
    ...new Map(runs.flatMap((r) => r.coverage).map((c) => [JSON.stringify(c), c])).values(),
  ];
  const ciRuns = runs.filter((r) => r.event !== 'local');
  const knownCost = ciRuns.filter((r) => Number.isFinite(r.runnerMinutes));
  const refs = new Set(runs.map((r) => `${r.id}:${r.attempt}`));
  const alarms = [
    ...new Map(
      human.falseAlarms
        .filter((f) => refs.has(`${f.runId}:${f.attempt}`))
        .map((f) => [`${f.runId}:${f.attempt}`, f])
    ).values(),
  ];
  const uniqueRuns = new Set(ciRuns.map((r) => r.id)).size;
  const weekStart = asOf - 7 * 86400000;
  const weekRuns = ciRuns.filter((r) => Date.parse(r.startedAt) >= weekStart);
  const weekHeads = headList.filter((h) => Date.parse(h.firstObservedAt) >= weekStart);
  const weekClosures = closures.filter((c) => Date.parse(c.repairedAt) >= weekStart);
  const weekCosts = weekRuns.filter((r) => Number.isFinite(r.runnerMinutes));
  return {
    schemaVersion: 1,
    asOf: report.asOf,
    weekly: {
      from: new Date(weekStart).toISOString(),
      through: report.asOf,
      firstPass: {
        numerator: weekHeads.filter((h) => h.firstValid?.state === 'pass').length,
        denominator: weekHeads.filter((h) => h.firstValid).length,
        noValidHeads: weekHeads.filter((h) => !h.firstValid).length,
      },
      attempts: weekRuns.length,
      reruns: weekRuns.filter((r) => r.attempt > 1).length,
      knownRunnerMinutes: weekCosts.length
        ? weekCosts.reduce((n, r) => n + r.runnerMinutes, 0)
        : 'not-measured',
      unknownCostAttempts: weekRuns.length - weekCosts.length,
      suppliedClosures: weekClosures.length,
    },
    inclusion: {
      observationStart: start,
      rule: 'All retained pull_request workflow heads since observationStart; first observed batch per head, excluding inconclusive/missing from the valid denominator; PR identity from GitHub run metadata. Unknown PR identity stays outside ten-PR cohorts.',
      historyCompleteness: 'limited-to-retained-C1-history',
    },
    firstPass: {
      numerator: valid.filter((h) => h.firstValid.state === 'pass').length,
      denominator: valid.length,
      heads: headList,
      inconclusiveAttempts: prRuns.filter((r) => firstBatch(r) === 'inconclusive').length,
      missingAttempts: prRuns.filter((r) => firstBatch(r) === 'not-measured').length,
      noValidHeads: headList.length - valid.length,
    },
    baseline: {
      firstTen: batches[0],
      nextTen: batches[1],
      comparison:
        batches.every((b) => b.progress === 10) &&
        headList.every((h) => h.pullRequests.length === 1)
          ? 'ready-for-human-bottleneck-analysis'
          : 'pending-next-ten',
      improvement: 'not-measured',
      unknownPrHeads: headList.filter((h) => h.pullRequests.length !== 1).length,
    },
    defects: {
      escapes: closures.length ? causes.reduce((n, c) => n + c.escapes, 0) : 'not-measured',
      recurrenceProposals: closures.length
        ? causes.reduce((n, c) => n + c.recurrence.length, 0)
        : 'not-measured',
      completeness: 'not-measured',
    },
    closureInput: input ? 'explicit-sanitized-records' : 'not-measured',
    closures,
    causes,
    prevention: {
      numerator: closures.filter((c) => c.preventionState === 'documented').length,
      denominator: closures.length,
      state: input ? 'reported-records-only-not-a-complete-private-ledger' : 'not-measured',
    },
    effort: {
      activeRepairMinutes:
        closures.length && closures.every((c) => c.activeRepairMinutes !== 'not-measured')
          ? closures.reduce((n, c) => n + c.activeRepairMinutes, 0)
          : 'not-measured',
      calendarMinutes: closures.length
        ? closures.reduce((n, c) => n + c.calendarMinutes, 0)
        : 'not-measured',
    },
    cost: {
      knownRunnerMinutes: knownCost.length
        ? knownCost.reduce((n, r) => n + r.runnerMinutes, 0)
        : 'not-measured',
      measuredAttempts: knownCost.length,
      missingAttempts: ciRuns.length - knownCost.length,
      kind: 'sum-of-job-execution-time-not-billing',
      reruns: ciRuns.filter((r) => r.attempt > 1).length,
      attemptCount: ciRuns.length,
      runCount: uniqueRuns,
      diagnosticBatches: runs.reduce(
        (n, r) => n + r.cells.reduce((m, c) => m + Math.max(0, c.batches.length - 1), 0),
        0
      ),
      falseAlarms: input ? alarms : 'not-measured',
      falseAlarmCompleteness: 'not-measured',
    },
    coverageDebt: {
      observations: coverage,
      implementedRoutes: human.implementedRoutes.map((r) => ({
        ...r,
        state: 'not-measured',
        limitation: 'explicit-implementation-inventory-does-not-certify-required-coverage',
      })),
      inventoryCompleteness: 'not-measured',
      expiredExceptions: human.exceptions.filter((e) => Date.parse(e.expiresAt) <= asOf),
      exceptions: human.exceptions,
    },
    schedule: report.schedule,
    monitoring: report.state,
    sources: runs.map((r) => ({
      id: r.id,
      attempt: r.attempt,
      url: r.url,
      event: r.event,
      headSha: r.headSha,
      measuredSha: r.measuredSha,
      state: r.state,
      environment: environmentKey(r),
    })),
    limitations: [
      'Human closure, escape and false-alarm input is optional and never an exhaustive private-ledger claim.',
      'Closure prevention links are human assertions; sourceVerified checks the failing SHA/cause/environment only, not the linked green gate.',
      'Recurrence is a proposal on the existing cause/address; later runs can measure older code.',
      'Retained history can be incomplete; missing artifacts, unknown PR identity and unknown time are not zero.',
      'Available green cells do not certify preview, themes, manual tasks or release coverage.',
    ],
  };
}
export function factoryMarkdown(r) {
  return [
    '# Frontend quality factory report',
    '',
    `As of ${r.asOf}. Monitoring: **${r.monitoring}**.`,
    '',
    `Trailing week ${r.weekly.from} to ${r.weekly.through}: first-pass ${r.weekly.firstPass.numerator}/${r.weekly.firstPass.denominator}, ${r.weekly.firstPass.noValidHeads} heads without valid evidence; ${r.weekly.attempts} attempts/${r.weekly.reruns} reruns; known runner minutes ${r.weekly.knownRunnerMinutes}, ${r.weekly.unknownCostAttempts} attempts with unknown cost; ${r.weekly.suppliedClosures} supplied closures.`,
    '',
    `Cumulative first pass: **${r.firstPass.numerator}/${r.firstPass.denominator}** frontend PR heads with a valid first batch; ${r.firstPass.noValidHeads} heads without valid evidence. Inconclusive attempts: ${r.firstPass.inconclusiveAttempts}; missing attempts: ${r.firstPass.missingAttempts}.`,
    `Baseline: **${r.baseline.firstTen.progress}/10 PRs**; next cohort ${r.baseline.nextTen.progress}/10. Unknown PR identity: ${r.baseline.unknownPrHeads} heads. Comparison: ${r.baseline.comparison}; improvement: not-measured.`,
    '',
    `Prevention: ${r.prevention.numerator}/${r.prevention.denominator} supplied closures documented (${r.prevention.state}). Active repair minutes: ${r.effort.activeRepairMinutes}; calendar minutes: ${r.effort.calendarMinutes}.`,
    `CI runner minutes: ${r.cost.knownRunnerMinutes} (${r.cost.measuredAttempts} measured / ${r.cost.missingAttempts} unknown attempts; execution time, not billing). Reruns: ${r.cost.reruns}/${r.cost.attemptCount} attempts (${r.cost.runCount} distinct workflow runs); diagnostic batches: ${r.cost.diagnosticBatches}. False alarms: ${Array.isArray(r.cost.falseAlarms) ? `${r.cost.falseAlarms.length} supplied records; completeness not-measured` : 'not-measured'}.`,
    '',
    `Escapes: ${r.defects.escapes}; recurrence proposals: ${r.defects.recurrenceProposals}; private-ledger completeness not-measured.`,
    ...r.causes.map(
      (c) =>
        `- Cause ${c.key}, ${c.address}: ${c.escapes} confirmed supplied escapes; ${c.recurrence.length} recurrence proposals.`
    ),
    ...r.closures.map(
      (c) =>
        `- Closure ${c.key}: ${c.defectSha} -> ${c.repairedSha}; environment ${c.environment}; prevention ${c.preventionState}; ${JSON.stringify(c.prevention)}; active minutes ${c.activeRepairMinutes}.`
    ),
    '',
    `Expired exceptions: ${r.coverageDebt.expiredExceptions.length} supplied records; inventory completeness not-measured.`,
    ...r.coverageDebt.expiredExceptions.map(
      (e) =>
        `- ${e.id}: ${e.owner} ${e.address}, ${e.cell}/${e.criterion}, expired ${e.expiresAt}; [decision](${e.decision}).`
    ),
    ...r.coverageDebt.observations.map(
      (c) =>
        `- Coverage ${c.route}: ${c.state}, ${c.owner} ${c.address}; dependency ${c.dependency ?? 'see contract'}.`
    ),
    ...r.coverageDebt.implementedRoutes.map(
      (c) =>
        `- Implemented coverage debt ${c.route}: ${c.state}, ${c.owner} ${c.address}; [source](${c.source}).`
    ),
    '',
    ...(r.schedule.windows ?? []).map(
      (w) =>
        `Weekly due ${w.dueAt}, overdue ${w.overdueAt}: ${w.state}; ${w.graceHours}h operational grace. Actual schedule events only.`
    ),
    '',
    '| Run / attempt | Event | Measured SHA | State |',
    '| --- | --- | --- | --- |',
    ...r.sources.map(
      (s) =>
        `| [${s.id}/${s.attempt}](${s.url}) | ${s.event} | ${s.measuredSha ?? 'not-measured'} | ${s.state} |`
    ),
    '',
    ...r.limitations.map((s) => `- ${s}`),
    '',
  ].join('\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) =>
    process.argv
      .slice(2)
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  if (!option('input') || !option('out'))
    throw new Error('Use --input=C1-SUMMARY.json --out=NEW-DIR [--closures=SANITIZED.json]');
  const out = resolve(option('out'));
  if (existsSync(out)) throw new Error('Factory output exists');
  const report = factory(
    JSON.parse(readFileSync(resolve(option('input')), 'utf8')),
    option('closures') ? JSON.parse(readFileSync(resolve(option('closures')), 'utf8')) : null
  );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'factory.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out, 'factory.md'), factoryMarkdown(report));
  console.log(
    `Factory first pass ${report.firstPass.numerator}/${report.firstPass.denominator}; baseline ${report.baseline.firstTen.progress}/10. ${out}`
  );
}
