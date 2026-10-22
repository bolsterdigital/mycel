// The changelog parser of scripts/release.mjs against a fixture log in the exact format it reads
// from git (LOG_FORMAT): squash titles with `(#NN)`, a merge commit, a breaking marker in the type
// and in a footer, a non-conventional subject, and the release commit that must stay out.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLog, renderEntries, sectionOf, updateChangelog } from './release.mjs';

const record = (hash, subject, body = '') => `\x1e${hash}\x1f${subject}\x1f${body}`;
const FIXTURE = [
  record('a1', 'feat(release): GHCR image, changelog and upgrade promise (TODO #18b) (#29)'),
  record('b2', 'chore(release): v0.0.9'),
  record('c3', 'Merge pull request #12 from bolsterdigital/fix-x', 'fix(db): close the pool\n'),
  record('d4', 'feat(api)!: drop the v0 routes (#30)'),
  record('e5', 'refactor: split compose.ts (#31)', 'Body.\n\nBREAKING CHANGE: createRuntime moved'),
  record('f6', 'Jobs table and scheduler (TODO #15) (#9)'),
  record('g7', 'docs: accept ADR 020 (#13)'),
  record('h8', 'ADR 003: events partitioned by month'),
].join('\n');

test('parses squash titles, merges and breaking markers', () => {
  const entries = parseLog(FIXTURE);
  assert.deepEqual(
    entries.map(({ hash, type, scope, description, breaking, pr }) => ({
      hash,
      type,
      scope,
      description,
      breaking,
      pr,
    })),
    [
      {
        hash: 'a1',
        type: 'feat',
        scope: 'release',
        description: 'GHCR image, changelog and upgrade promise (TODO #18b)',
        breaking: false,
        pr: 29,
      },
      {
        hash: 'c3',
        type: 'fix',
        scope: 'db',
        description: 'close the pool',
        breaking: false,
        pr: 12,
      },
      {
        hash: 'd4',
        type: 'feat',
        scope: 'api',
        description: 'drop the v0 routes',
        breaking: true,
        pr: 30,
      },
      {
        hash: 'e5',
        type: 'refactor',
        scope: undefined,
        description: 'split compose.ts',
        breaking: true,
        pr: 31,
      },
      {
        hash: 'f6',
        type: 'other',
        scope: undefined,
        description: 'Jobs table and scheduler (TODO #15)',
        breaking: false,
        pr: 9,
      },
      {
        hash: 'g7',
        type: 'docs',
        scope: undefined,
        description: 'accept ADR 020',
        breaking: false,
        pr: 13,
      },
      {
        hash: 'h8',
        type: 'other',
        scope: undefined,
        description: 'ADR 003: events partitioned by month',
        breaking: false,
        pr: undefined,
      },
    ]
  );
});

test('renders breaking changes first, then the groups, with PR links', () => {
  const md = renderEntries(parseLog(FIXTURE));
  const titles = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(titles, ['Breaking changes', 'Features', 'Fixes', 'Documentation', 'Other']);
  assert.match(
    md,
    /- \*\*api:\*\* drop the v0 routes \(\[#30\]\(https:\/\/github\.com\/bolsterdigital\/mycel\/pull\/30\)\)/
  );
  assert.match(md, /^- ADR 003: events partitioned by month$/m);
});

test('a release empties Unreleased and inserts its section above the older ones', () => {
  const before =
    '# Changelog\n\nIntro.\n\n## Unreleased\n\n- preview\n\n## 0.1.0 - 2026-10-01\n\n- old\n';
  const after = updateChangelog(before, {
    unreleasedBody: '',
    version: '0.2.0',
    date: '2026-11-01',
    body: '### Fixes\n\n- new',
  });
  assert.equal(
    after,
    '# Changelog\n\nIntro.\n\n## Unreleased\n\n## 0.2.0 - 2026-11-01\n\n### Fixes\n\n- new\n\n' +
      '## 0.1.0 - 2026-10-01\n\n- old\n'
  );
  assert.equal(sectionOf(after, '0.2.0'), '### Fixes\n\n- new');
  assert.equal(sectionOf(after, '0.1.0'), '- old');
  assert.throws(() => sectionOf(after, '0.3.0'), /no section for 0\.3\.0/);
});

test('starts a changelog from nothing with a header and an Unreleased section', () => {
  const md = updateChangelog('', { unreleasedBody: '### Features\n\n- x' });
  assert.match(md, /^# Changelog\n/);
  assert.match(md, /## Unreleased\n\n### Features\n\n- x\n$/);
});
