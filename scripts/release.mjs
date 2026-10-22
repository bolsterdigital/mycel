#!/usr/bin/env node
// Cut a release (TODO #18b, docs/upgrading.md): `npm run release -- 0.1.0` collects the commits
// since the previous tag, writes their section at the top of CHANGELOG.md, sets the version in
// every package.json and the lockfile, commits `chore(release): v0.1.0` signed off and tags
// `v0.1.0`. Pushing stays a human step (`git push --follow-tags`): the tag starts the release
// workflow, which builds and publishes the image. The squash-merge title of each PR is the
// changelog line, which is why PR titles are conventional commits (CONTRIBUTING.md).
//
//   npm run release -- 0.1.0        cut the release on a clean main
//   npm run release -- unreleased   rewrite the `## Unreleased` preview from the commits so far
//   node scripts/release.mjs notes 0.1.0   print a version's section (the GitHub Release text)
//
// Our own ~200 lines (ADR 008 rule 1) instead of semantic-release or changesets, which bring a
// plugin ecosystem, decide the version for you and want write access to the repository.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'https://github.com/bolsterdigital/mycel';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Changelog groups in display order; a type not listed lands in "Other". */
export const GROUPS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
];

/** The git log format `parseLog` reads: records split by \x1e, subject and body by \x1f. */
export const LOG_FORMAT = '%x1e%H%x1f%s%x1f%b';

/**
 * Commits from `git log --format=LOG_FORMAT`, newest first, as changelog entries. A squash merge
 * carries its PR as a trailing `(#NN)`; a merge commit ("Merge pull request #NN from …") carries
 * it in the subject and the PR title as the first body line. Breaking: `!` after the type or a
 * `BREAKING CHANGE:` footer. Release commits are left out.
 */
export function parseLog(text) {
  const entries = [];
  for (const record of text.split('\x1e')) {
    if (!record.trim()) continue;
    const [hash = '', rawSubject = '', body = ''] = record.split('\x1f');
    let subject = rawSubject.trim();
    let pr;
    const merge = /^Merge pull request #(\d+) from \S+/.exec(subject);
    if (merge) {
      pr = Number(merge[1]);
      subject = body.trim().split('\n')[0]?.trim() || subject;
    }
    const trailing = /\s*\(#(\d+)\)$/.exec(subject);
    if (trailing) {
      pr ??= Number(trailing[1]);
      subject = subject.slice(0, trailing.index);
    }
    const cc = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
    const type = cc ? cc[1].toLowerCase() : 'other';
    if (type === 'chore' && cc?.[2] === 'release') continue;
    entries.push({
      hash: hash.trim(),
      type,
      scope: cc?.[2],
      description: cc ? cc[4] : subject,
      breaking: Boolean(cc?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
      pr,
    });
  }
  return entries;
}

const line = (e) => {
  const scope = e.scope ? `**${e.scope}:** ` : '';
  const link = e.pr ? ` ([#${e.pr}](${REPO_URL}/pull/${e.pr}))` : '';
  return `- ${scope}${e.description}${link}`;
};

/** The body of one changelog section: breaking changes first, then the groups. */
export function renderEntries(entries) {
  const blocks = [];
  const breaking = entries.filter((e) => e.breaking);
  if (breaking.length) blocks.push(['Breaking changes', breaking]);
  const known = new Set(GROUPS.map(([t]) => t));
  for (const [type, title] of GROUPS)
    blocks.push([title, entries.filter((e) => e.type === type && !e.breaking)]);
  blocks.push(['Other', entries.filter((e) => !known.has(e.type) && !e.breaking)]);
  return blocks
    .filter(([, list]) => list.length)
    .map(([title, list]) => `### ${title}\n\n${list.map(line).join('\n')}`)
    .join('\n\n');
}

const HEADER = `# Changelog

All notable changes to Mycel. Each line is the title of a merged pull request (a conventional commit, see [CONTRIBUTING.md](CONTRIBUTING.md)); \`npm run release\` writes the sections, and \`## Unreleased\` is a preview it replaces. Upgrading between versions: [docs/upgrading.md](docs/upgrading.md). Versions before 1.0 may break in a minor release; the changelog says so under "Breaking changes".
`;

/** Section headings (`## …`) with their start offset. */
const sections = (text) =>
  [...text.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1].trim(), at: m.index }));

/**
 * `changelog` with `## Unreleased` set to `unreleasedBody` and, when `version` is given, a new
 * section `## <version> - <date>` right below it. Everything else stays as it was.
 */
export function updateChangelog(changelog, { unreleasedBody, version, date, body }) {
  const text = changelog.trim() ? changelog : HEADER;
  const all = sections(text);
  const unreleased = all.find((s) => s.title === 'Unreleased');
  const firstRelease = all.find((s) => s.title !== 'Unreleased');
  const head = text.slice(0, unreleased?.at ?? firstRelease?.at ?? text.length).trimEnd();
  const rest = firstRelease ? text.slice(firstRelease.at).trimEnd() : '';
  const parts = [head, `## Unreleased${unreleasedBody ? `\n\n${unreleasedBody}` : ''}`];
  if (version) parts.push(`## ${version} - ${date}\n\n${body || '_No changes._'}`);
  if (rest) parts.push(rest);
  return parts.join('\n\n') + '\n';
}

/** The body of `## <version> …`, for the GitHub Release; throws when there is none. */
export function sectionOf(changelog, version) {
  const all = sections(changelog);
  const i = all.findIndex((s) => s.title === version || s.title.startsWith(`${version} `));
  if (i < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const start = changelog.indexOf('\n', all[i].at) + 1;
  return changelog.slice(start, all[i + 1]?.at ?? changelog.length).trim();
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function previousTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  } catch {
    return undefined;
  }
}

function entriesSince(tag) {
  return parseLog(git('log', `--format=${LOG_FORMAT}`, tag ? `${tag}..HEAD` : 'HEAD'));
}

/** Root, every workspace and the lockfile entries for them, all to `version`. */
function bumpVersions(version) {
  const root = readJson(join(ROOT, 'package.json'));
  root.version = version;
  writeJson(join(ROOT, 'package.json'), root);
  const lock = readJson(join(ROOT, 'package-lock.json'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  const files = ['package.json', 'package-lock.json'];
  for (const dir of git('ls-files', 'packages/*/package.json', 'apps/*/package.json').split('\n')) {
    const path = join(ROOT, dir);
    const pkg = readJson(path);
    pkg.version = version;
    writeJson(path, pkg);
    const entry = lock.packages?.[dir.replace(/\/package\.json$/, '')];
    if (entry) entry.version = version;
    files.push(dir);
  }
  writeJson(join(ROOT, 'package-lock.json'), lock);
  return files;
}

function writeChangelog(update) {
  const path = join(ROOT, 'CHANGELOG.md');
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {}
  writeFileSync(path, updateChangelog(current, update));
  execFileSync('npx', ['prettier', '--write', 'CHANGELOG.md'], { cwd: ROOT, stdio: 'ignore' });
}

function release(version) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('release from main');
  if (git('status', '--porcelain')) throw new Error('the working tree is not clean');
  if (git('tag', '--list', `v${version}`)) throw new Error(`tag v${version} exists already`);
  const body = renderEntries(entriesSince(previousTag()));
  const date = new Date().toISOString().slice(0, 10);
  writeChangelog({ unreleasedBody: '', version, date, body });
  const files = bumpVersions(version);
  git('add', 'CHANGELOG.md', ...files);
  git('commit', '-s', '-m', `chore(release): v${version}`);
  git('tag', '-a', `v${version}`, '-m', `v${version}`);
  console.log(`v${version} committed and tagged. Push it: git push --follow-tags`);
}

function main([command, arg]) {
  if (command === 'notes') {
    console.log(sectionOf(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), arg ?? ''));
  } else if (command === 'unreleased') {
    writeChangelog({ unreleasedBody: renderEntries(entriesSince(previousTag())) });
  } else if (command) {
    release(command);
  } else {
    throw new Error('usage: npm run release -- <X.Y.Z> | unreleased | notes <X.Y.Z>');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
