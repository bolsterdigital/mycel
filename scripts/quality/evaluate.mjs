// Lighthouse's best-of-run assertion can conceal a failing median. This evaluator keeps every
// batch and validates provenance and page identity before scores; no LHCI upload or aggregation.
export const categories = ['performance', 'accessibility', 'best-practices', 'seo'];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function evaluateBatch(contract, samples) {
  const structural = [];
  const failures = [];
  if (samples.length !== 5) structural.push('sample-count');
  const applicable = categories.filter((key) => key !== 'seo' || contract.indexable);
  for (const sample of samples) {
    const report = sample.report;
    if (!equal(sample.provenance, contract.provenance)) structural.push('provenance');
    if (!report || report.runtimeError || sample.error) structural.push('runtime-error');
    if (!sample.identity?.valid) structural.push('page-identity');
    if (sample.identity?.functionalFailures?.length)
      failures.push(...sample.identity.functionalFailures);
    if ((report?.finalDisplayedUrl ?? report?.finalUrl) !== contract.url)
      structural.push('final-url');
    if (report?.lighthouseVersion !== contract.provenance.lighthouse)
      structural.push('lighthouse-version');
    for (const key of applicable) {
      const score = report?.categories?.[key]?.score;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)
        structural.push(`missing-category:${key}`);
      else if (key !== 'performance' && score !== 1) failures.push(key);
    }
    if (!contract.indexable && !sample.identity?.noindex) failures.push('admin-noindex');
    if (!contract.indexable && !sample.identity?.privateCache) failures.push('admin-private-cache');
  }
  const raw = samples.map((sample) =>
    Object.fromEntries(
      categories.map((key) => [key, sample.report?.categories?.[key]?.score ?? null])
    )
  );
  const performance = raw.map((scores) => scores.performance);
  const completePerformance = performance.length === 5 && performance.every(Number.isFinite);
  const middle = completePerformance ? median(performance) : null;
  if (middle !== null && middle < 0.995) failures.push('performance');
  if (middle !== null && middle >= 0.995 && Math.min(...performance) < 0.98)
    structural.push('unstable-performance');
  // Deterministic failures stay failures even if a different sample is structurally invalid.
  const state = failures.length ? 'fail' : structural.length ? 'inconclusive' : 'pass';
  return {
    state,
    reasons: [...new Set([...failures, ...structural])],
    sampleIds: samples.map((sample) => sample.id),
    raw,
    performance: {
      median: middle,
      min: completePerformance ? Math.min(...performance) : null,
      max: completePerformance ? Math.max(...performance) : null,
    },
    failedAuditIds: [
      ...new Set(
        samples.flatMap((sample) =>
          Object.entries(sample.report?.audits ?? {})
            .filter(([, audit]) => typeof audit.score === 'number' && audit.score < 1)
            .map(([id]) => id)
        )
      ),
    ],
    metrics: samples.map((sample) =>
      Object.fromEntries(
        [
          'first-contentful-paint',
          'largest-contentful-paint',
          'total-blocking-time',
          'cumulative-layout-shift',
          'speed-index',
          'total-byte-weight',
          'mainthread-work-breakdown',
        ].map((id) => [id, sample.report?.audits?.[id]?.numericValue ?? null])
      )
    ),
  };
}

export function evaluateCell(contract, batches) {
  const results = batches.map((samples) => evaluateBatch(contract, samples));
  return {
    state: results.some((result) => result.state === 'fail')
      ? 'fail'
      : !results.length
        ? 'not-measured'
        : results.some((result) => result.state !== 'pass')
          ? 'inconclusive'
          : 'pass',
    batches: results,
  };
}

// The proposal key is a cause class, never a route. Private planning owns triage and closure.
export function repairProposals(cells, ledger = [], now = new Date()) {
  const proposals = new Map();
  for (const cell of cells) {
    if (cell.state === 'pass') continue;
    for (const reason of new Set(
      cell.batches.length ? cell.batches.flatMap((batch) => batch.reasons) : ['not-measured']
    )) {
      const category = ['performance', 'accessibility', 'best-practices', 'seo'].includes(reason)
        ? reason
        : 'measurement';
      const key =
        category === 'measurement'
          ? reason
          : `${category}:${cell.batches
              .flatMap((b) => b.failedAuditIds)
              .sort()
              .join(',')}`;
      const previous = ledger.find((item) => item.key === key);
      const proposal = proposals.get(key) ?? {
        key,
        owner: category === 'measurement' ? 'dev' : 'mbp',
        address:
          previous?.address ??
          (category === 'seo' ? '#9' : category === 'measurement' ? '#43B' : '#43C'),
        recurrence: previous?.status === 'closed',
        expiredException: Boolean(previous?.expires && new Date(previous.expires) <= now),
        cells: [],
      };
      proposal.cells.push(cell.id);
      proposals.set(key, proposal);
    }
  }
  return [...proposals.values()];
}
