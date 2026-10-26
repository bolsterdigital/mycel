// Read-only GitHub adapter. Download only sanitized summary.json entries, never raw reports,
// and keep each run attempt/artifact at its own address instead of overwriting old batches.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceContract } from './consume.mjs';

const activation = '2026-10-26T17:30:57Z';
export function collectHistory({ repo, out, runIds = [], api, download }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
  if (existsSync(out)) throw new Error('History output exists');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const history = {
    schemaVersion: 1,
    repository: repo,
    workflow: { state: 'unknown', activatedAt: activation },
    runs: [],
    errors: [],
  };
  const base = `repos/${repo}`;
  // An API failure is evidence loss, never an empty successful history.
  try {
    const workflow = api(`${base}/actions/workflows/frontend-quality.yml`);
    history.workflow.state = workflow.state;
    const file = api(`${base}/contents/.github/workflows/frontend-quality.yml?ref=main`);
    history.workflow.cron = /cron: '([^']+)'/.exec(
      Buffer.from(file.content, 'base64').toString()
    )?.[1];
    const watchdog = api(`${base}/actions/workflows/frontend-quality-watchdog.yml`);
    const previous = api(
      `${base}/actions/workflows/frontend-quality-watchdog.yml/runs?per_page=100`
    ).workflow_runs.find((r) => r.status === 'completed' && r.event === 'schedule');
    history.watchdog = {
      state: watchdog.state,
      lastCompletedAt: previous?.updated_at,
      conclusion: previous?.conclusion,
    };
  } catch {
    history.errors.push('workflow-api-unavailable');
  }
  const sources = new Map();
  const source = (commit, path) => {
    const id = `${commit}:${path}`;
    if (!sources.has(id)) {
      const file = api(`${base}/contents/${path}?ref=${commit}`);
      sources.set(id, Buffer.from(file.content, 'base64').toString());
    }
    return sources.get(id);
  };
  const contractFor = (commit) =>
    sourceContract({
      corpus: source(commit, 'apps/web/e2e/quality-corpus.json'),
      seed: source(commit, 'scripts/e2e.mjs'),
      matrixSource: source(commit, 'scripts/quality/matrix.mjs'),
      workflow: source(commit, '.github/workflows/frontend-quality.yml'),
      lock: source(commit, 'package-lock.json'),
    });
  let runs = [];
  try {
    // Paginate all runs from rollout, including failed/cancelled runs, not only green artifacts.
    for (let page = 1; ; page++) {
      const batch = api(
        `${base}/actions/workflows/frontend-quality.yml/runs?per_page=100&page=${page}&created=%3E%3D${activation}`
      ).workflow_runs;
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    for (const id of runIds) {
      if (!/^\d+$/.test(String(id))) throw new Error('Invalid run id');
      if (!runs.some((r) => String(r.id) === String(id)))
        runs.push(api(`${base}/actions/runs/${id}`));
    }
  } catch {
    history.errors.push('runs-api-unavailable');
  }
  for (const latest of runs) {
    for (let attempt = 1; attempt <= latest.run_attempt; attempt++) {
      const record = { id: latest.id, attempt, artifacts: [] };
      history.runs.push(record);
      try {
        const run = api(`${base}/actions/runs/${latest.id}/attempts/${attempt}`);
        if (run.path?.split('@')[0] !== '.github/workflows/frontend-quality.yml')
          throw new Error('unrelated-workflow');
        Object.assign(record, {
          event: run.event,
          headSha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.created_at,
          startedAt: run.run_started_at,
          url: `${run.html_url}/attempts/${attempt}`,
        });
        if (!/^[a-f0-9]{40}$/.test(record.headSha)) throw new Error('invalid-head-sha');
        record.contract = contractFor(record.headSha);
        record.expectationSha = record.headSha;
        let artifacts = [];
        for (let page = 1; ; page++) {
          const batch = api(
            `${base}/actions/runs/${latest.id}/artifacts?per_page=100&page=${page}`
          ).artifacts;
          artifacts.push(...batch);
          if (batch.length < 100) break;
        }
        // GitHub's artifacts endpoint is run-wide. Assign by immutable creation times between
        // attempt starts; a rerun must not borrow a green artifact from a prior attempt.
        const next =
          attempt < latest.run_attempt
            ? api(`${base}/actions/runs/${latest.id}/attempts/${attempt + 1}`)
            : null;
        artifacts = artifacts.filter(
          (a) =>
            a.name.startsWith('quality-summary-') &&
            Date.parse(a.created_at) >= Date.parse(run.run_started_at ?? run.created_at) &&
            (!next || Date.parse(a.created_at) < Date.parse(next.run_started_at))
        );
        const commits = new Set();
        for (const artifact of artifacts) {
          const entry = { id: artifact.id, name: artifact.name };
          record.artifacts.push(entry);
          try {
            if (artifact.expired) throw new Error('expired');
            const body = download(artifact.id);
            const report = JSON.parse(body);
            if (!/^[a-f0-9]{40}$/.test(report.commit)) throw new Error('commit');
            commits.add(report.commit);
            entry.path = `${run.id}/${attempt}/${artifact.id}.json`;
            mkdirSync(join(out, String(run.id), String(attempt)), { recursive: true });
            writeFileSync(join(out, entry.path), body, { mode: 0o600 });
          } catch {
            entry.error = 'unavailable-or-corrupt';
          }
        }
        if (commits.size !== 1) throw new Error('missing-or-mixed-measured-sha');
        record.measuredSha = [...commits][0];
        // For PRs, checkout measures the merge commit. Verify its relationship to the run's
        // head; never relabel an arbitrary artifact SHA as PR evidence.
        const commit = api(`${base}/commits/${record.measuredSha}`);
        record.mergeParents = commit.parents.map((p) => p.sha);
        if (
          record.measuredSha !== record.headSha &&
          !(record.event === 'pull_request' && commit.parents.some((p) => p.sha === record.headSha))
        )
          throw new Error('unrelated-merge-sha');
        record.contract = contractFor(record.measuredSha);
        record.expectationSha = record.measuredSha;
      } catch {
        record.error = 'incomplete-run-or-source-contract';
      }
    }
  }
  writeFileSync(join(out, 'history.json'), JSON.stringify(history, null, 2), { mode: 0o600 });
  return history;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) =>
    process.argv
      .slice(2)
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  const out = resolve(option('out') ?? '');
  if (!option('out')) throw new Error('Use --repo=OWNER/REPO --out=NEW-DIR [--run=ID,ID]');
  const api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', '--method', 'GET', path], {
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  collectHistory({
    repo: option('repo') ?? process.env.GITHUB_REPOSITORY,
    out,
    runIds: option('run')?.split(',') ?? [],
    api,
    download: (id) => {
      const archive = join(out, `${id}.zip`);
      try {
        writeFileSync(
          archive,
          execFileSync(
            'gh',
            [
              'api',
              '--method',
              'GET',
              `repos/${option('repo') ?? process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`,
            ],
            { maxBuffer: 30 * 1024 * 1024 }
          ),
          { mode: 0o600 }
        );
        const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
          .trim()
          .split('\n');
        if (names.length !== 1 || names[0] !== 'summary.json')
          throw new Error('Unexpected artifact entries');
        return execFileSync('unzip', ['-p', archive, 'summary.json'], {
          encoding: 'utf8',
          maxBuffer: 30 * 1024 * 1024,
        });
      } finally {
        if (existsSync(archive)) rmSync(archive);
      }
    },
  });
  console.log(`Read-only history retained in ${out}`);
}
