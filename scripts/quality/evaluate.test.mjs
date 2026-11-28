// Adversarial fixtures test the measurement contract, not the product renderer. In particular a
// login, missing asset or late green rerun must not become a high-scoring passing page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateBatch, evaluateCell, repairProposals } from './evaluate.mjs';
const provenance = {
  commit: 'abc',
  fixtureHash: '123',
  lighthouse: '13.5.0',
  runner: 'ci',
  mode: 'ci',
  profile: 'mobile',
};
const contract = { url: 'https://localhost:4443/probe/campagne', indexable: true, provenance };
function samples(scores = [1, 1, 1, 1, 1]) {
  return scores.map((performance, id) => ({
    id,
    provenance: { ...provenance },
    identity: { valid: true, noindex: true, privateCache: true, functionalFailures: [] },
    report: {
      finalDisplayedUrl: contract.url,
      lighthouseVersion: provenance.lighthouse,
      categories: Object.fromEntries(
        ['performance', 'accessibility', 'best-practices', 'seo'].map((key) => [
          key,
          { score: key === 'performance' ? performance : 1 },
        ])
      ),
      audits: { 'total-byte-weight': { numericValue: 123 } },
    },
  }));
}
test('five representative good reports pass; 99 and deterministic shortfalls fail', () => {
  assert.equal(evaluateBatch(contract, samples()).state, 'pass');
  assert.equal(evaluateBatch(contract, samples([0.99, 0.99, 0.99, 0.99, 0.99])).state, 'fail');
  for (const key of ['accessibility', 'best-practices', 'seo']) {
    const batch = samples();
    batch[0].report.categories[key].score = 0.99;
    assert.equal(evaluateBatch(contract, batch).state, 'fail');
  }
  for (const score of [null, undefined, NaN]) {
    const batch = samples();
    batch[0].report.categories.performance.score = score;
    assert.equal(evaluateBatch(contract, batch).state, 'inconclusive');
  }
});
test('median, instability and immutable failed first batch', () => {
  const failing = samples([1, 0.99, 0.99, 0.99, 1]);
  assert.equal(evaluateBatch(contract, failing).state, 'fail');
  assert.equal(evaluateBatch(contract, samples([0.97, 1, 1, 1, 1])).state, 'inconclusive');
  assert.equal(evaluateCell(contract, [failing, samples()]).state, 'fail');
  assert.equal(evaluateCell(contract, []).state, 'not-measured');
  assert.equal(
    repairProposals([{ id: 'missing', ...evaluateCell(contract, []) }])[0].key,
    'not-measured'
  );
});
test('login, 404, missing asset, wrong locale/shell and provenance never pass', () => {
  for (const reason of ['login', '404', 'image', 'locale', 'empty-shell']) {
    const batch = samples();
    batch[0].identity.valid = false;
    batch[0].identity.reason = reason;
    assert.equal(evaluateBatch(contract, batch).state, 'inconclusive');
  }
  for (const key of Object.keys(provenance)) {
    const batch = samples();
    batch[0].provenance[key] = 'different';
    assert.equal(evaluateBatch(contract, batch).state, 'inconclusive');
  }
  const redirected = samples();
  redirected[0].report.finalDisplayedUrl = 'https://localhost/admin/login';
  assert.equal(evaluateBatch(contract, redirected).state, 'inconclusive');
  const missing = samples();
  missing.pop();
  assert.equal(evaluateBatch(contract, missing).state, 'inconclusive');
  const broken = samples();
  broken[0].report.runtimeError = { code: 'NO_FCP' };
  assert.equal(evaluateBatch(contract, broken).state, 'inconclusive');
});
test('admin SEO is inapplicable, private noindex remains required; hidden integration fails', () => {
  const batch = samples();
  delete batch[0].report.categories.seo;
  assert.equal(evaluateBatch({ ...contract, indexable: false }, batch).state, 'pass');
  batch[0].identity.noindex = false;
  assert.equal(evaluateBatch({ ...contract, indexable: false }, batch).state, 'fail');
  batch[0].identity.noindex = true;
  batch[0].identity.privateCache = false;
  assert.equal(evaluateBatch({ ...contract, indexable: false }, batch).state, 'fail');
  const hidden = samples();
  hidden[0].identity.functionalFailures = ['missing-enabled-integration'];
  assert.equal(evaluateBatch(contract, hidden).state, 'fail');
});
test('the search route scores three categories at 100, not SEO, and keeps a public noindex', () => {
  const search = {
    url: 'https://localhost:4443/probe/search?q=buurt',
    indexable: false,
    publicNoindex: true,
    provenance,
  };
  const publicSamples = () =>
    samples().map((sample) => ({
      ...sample,
      identity: { ...sample.identity, privateCache: false },
      report: { ...sample.report, finalDisplayedUrl: search.url },
    }));
  // `is-crawlable` fails by design on a noindex page: an SEO score below 1 changes nothing.
  const crawl = publicSamples();
  for (const sample of crawl) sample.report.categories.seo.score = 0.66;
  assert.equal(evaluateBatch(search, crawl).state, 'pass');
  assert.deepEqual(Object.keys(evaluateBatch(search, crawl).failedAuditIdsByCategory), [
    'performance',
    'accessibility',
    'best-practices',
  ]);
  for (const category of ['accessibility', 'best-practices']) {
    const low = publicSamples();
    low[2].report.categories[category].score = 0.98;
    const result = evaluateBatch(search, low);
    assert.equal(result.state, 'fail');
    assert.ok(result.reasons.includes(category));
  }
  const slow = publicSamples().map((sample) => {
    sample.report.categories.performance.score = 0.98;
    return sample;
  });
  assert.ok(evaluateBatch(search, slow).reasons.includes('performance'));
  // A public cache is not the admin rule; losing noindex is a functional failure.
  assert.ok(!evaluateBatch(search, publicSamples()).reasons.includes('admin-private-cache'));
  const indexed = publicSamples();
  indexed[0].identity.noindex = false;
  assert.deepEqual(evaluateBatch(search, indexed).reasons, ['missing-noindex']);
  // Without the public flag the same samples are an admin page and fail on the public cache.
  assert.ok(
    evaluateBatch({ ...search, publicNoindex: undefined }, publicSamples()).reasons.includes(
      'admin-private-cache'
    )
  );
});
test('one cause on many routes gives one proposal with its category', () => {
  const result = evaluateCell(contract, [samples([0.99, 0.99, 0.99, 0.99, 0.99])]);
  const cells = [
    { ...result, id: 'campaign' },
    { ...result, id: 'article' },
  ];
  const first = repairProposals(cells);
  assert.equal(first.length, 1);
  assert.equal(first[0].cells.length, 2);
  assert.equal(first[0].category, 'performance');
  assert.equal(first[0].security, false);
});

test('a weighted audit error cannot hide behind a category score of 100', () => {
  const batch = samples();
  batch[0].report.categories.accessibility.auditRefs = [{ id: 'broken-audit', weight: 1 }];
  batch[0].report.audits['broken-audit'] = { score: null, scoreDisplayMode: 'error' };
  assert.equal(evaluateBatch(contract, batch).state, 'inconclusive');
});

test('cache failure retains every independent identity cause and marks only the security class', () => {
  const batch = samples();
  batch[0].identity = {
    valid: false,
    noindex: true,
    privateCache: false,
    functionalFailures: ['admin-private-cache'],
    reasons: ['admin-private-cache', 'wrong-item', 'empty-editor', 'locale'],
  };
  const proposals = repairProposals([
    { id: 'writer', ...evaluateCell({ ...contract, indexable: false }, [batch]) },
  ]);
  assert.deepEqual(
    new Set(proposals.map((p) => p.key)),
    new Set([
      'admin-private-cache',
      'page-identity:wrong-item',
      'page-identity:empty-editor',
      'page-identity:locale',
    ])
  );
  for (const proposal of proposals.filter((p) => p.key.startsWith('page-identity:'))) {
    assert.equal(proposal.category, 'measurement');
    assert.equal(proposal.security, false);
  }
  const privacy = proposals.find((p) => p.key === 'admin-private-cache');
  assert.equal(privacy.security, true);
  assert.equal(privacy.category, 'measurement');
});
