// A merge queue run whose commit has exactly the tree of the PR head reuses that head's passed
// pull_request run of the same workflow instead of repeating it (MY-183): the queue builds one
// entry at a time, so an up-to-date PR yields a queue commit with the same files, and running
// the same checks on the same files twice cost ten to fifteen minutes per merge. Every doubt
// (another event, no PR number, another tree, no completed successful run, an API error) answers
// "not reused" and the workflow runs in full; nothing here can turn a check green on its own.
// Rejected: a ruleset bypass for non-overlapping PRs (weakens the protection and needs a
// path-overlap judgement), and skipping on a path comparison with an older main (main may have
// moved under the same paths in ways a diff of names does not show).

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {{ event: string, mergeGroup?: { head_ref?: string, head_sha?: string },
 *   workflow: string, repository: string, api: (path: string) => Promise<any> }} input
 */
export async function decide({ event, mergeGroup, workflow, repository, api }) {
  if (event !== 'merge_group') return { reused: false, reason: `event ${event}, not a queue run` };
  const pr = /\/pr-(\d+)-[0-9a-f]{40}$/.exec(mergeGroup?.head_ref ?? '')?.[1];
  if (!pr || !/^[0-9a-f]{40}$/.test(mergeGroup?.head_sha ?? ''))
    return { reused: false, reason: 'no PR number or commit in the queue ref' };
  const head = (await api(`repos/${repository}/pulls/${pr}`))?.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(head ?? '')) return { reused: false, reason: `PR #${pr} has no head` };
  const tree = async (sha) => (await api(`repos/${repository}/git/commits/${sha}`))?.tree?.sha;
  const [queueTree, headTree] = await Promise.all([tree(mergeGroup.head_sha), tree(head)]);
  if (!queueTree || queueTree !== headTree)
    return { reused: false, reason: `the queue commit is not the tree of PR #${pr} head ${head}` };
  const runs = await api(
    `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${head}&event=pull_request&per_page=20`
  );
  // The newest run decides: a later red run on the same head is not hidden by an older green one.
  const latest = [...(runs?.workflow_runs ?? [])].sort((a, b) => b.run_number - a.run_number)[0];
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success')
    return { reused: false, reason: `no passed ${workflow} run on PR #${pr} head ${head}` };
  return {
    reused: true,
    reason: `same tree as PR #${pr} head ${head}, whose ${workflow} run passed`,
    run: latest.html_url,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflow = process.argv[2];
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const api = async (path) => {
    const response = await fetch(`${base}/${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  let result;
  try {
    const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = await decide({
      event: process.env.GITHUB_EVENT_NAME,
      mergeGroup: payload.merge_group,
      workflow,
      repository: process.env.GITHUB_REPOSITORY,
      api,
    });
  } catch (error) {
    result = { reused: false, reason: `lookup failed (${error.message}), running in full` };
  }
  const line = `Queue reuse: **${result.reused}**, ${result.reason}${result.run ? ` (${result.run})` : ''}.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${result.reused}\nrun=${result.run ?? ''}\n`);
}
