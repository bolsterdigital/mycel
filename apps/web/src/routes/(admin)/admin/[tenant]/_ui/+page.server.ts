// The living catalogue of the admin's shared components (brief #56 § A, PR 1): every component in
// lib/admin/ui with real admin copy, so a reviewer and the e2e UI gate see each one at 320 CSS px
// and 200% text in both locales. Only outside production and only for `tenant:admin`
// (+layout.server.ts). The table sorts on the server, as a real list would. Rejected: a Storybook-like
// tool (a second build, a second dependency tree, and it would not run under the admin's CSP and
// no-JavaScript rule that the components must hold).
import type { PageServerLoad } from './$types';

const ROWS = [
  { name: 'campaign-poster-final-version-2026.jpg', changed: '2026-10-21', size: 2_480_000 },
  { name: 'annual-report.pdf', changed: '2026-09-30', size: 845_000 },
  { name: 'volunteers-at-the-market.webp', changed: '2026-10-27', size: 1_120_000 },
] as const;

export const load: PageServerLoad = async ({ parent, url }) => {
  await parent();
  const key = url.searchParams.get('sort') === 'changed' ? 'changed' : 'name';
  const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  const rows = [...ROWS].sort((a, b) => a[key].localeCompare(b[key]) * (dir === 'asc' ? 1 : -1));
  return { sort: { key, dir } as const, rows };
};
