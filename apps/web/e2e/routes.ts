// The routes of the generic UI gate (ui-gate.spec.ts): pages whose state the seed of
// scripts/e2e/e2e.mjs already holds, so the gate only opens them. A route that needs state a flow
// makes first (a stuck task, an uploaded image, a page with four publication actions) keeps its
// gate in that flow's spec, on the same lib/layout.ts.
// Rejected: a fixture hook per route (the setup of a flow would live twice, here and in its spec).

/** One page of the gate. */
export interface GateRoute {
  path: string;
  /** Narrows the actions measured, for a page that holds more than its subject. */
  within?: string;
  /** Open every `.ui-fold` disclosure before measuring. */
  folds?: boolean;
  /** Open the admin's ☰ menu (closed by default at 320 CSS px) before measuring. */
  menu?: boolean;
}

/** Admin routes, measured signed in as the seeded tenant admin in both admin locales. */
export const ADMIN_ROUTES: GateRoute[] = [
  { path: '/admin/probe', menu: true },
  { path: '/admin/probe/leden', within: 'main', folds: true },
  { path: '/admin/probe/domeinen', within: 'main', folds: true },
  ...[
    '',
    '?section=theme',
    '?section=brand',
    '?section=chrome',
    '?section=assist',
    '?section=usage',
  ].map((section) => ({
    path: `/admin/probe/site${section}`,
    within: 'main',
  })),
  { path: '/admin/probe/site?section=api', within: 'main', folds: true },
  { path: '/admin/probe/connections', within: 'main', folds: true },
  { path: '/admin/probe/export', within: 'main', folds: true },
  { path: '/admin/probe/status', within: 'main', folds: true },
  { path: '/admin/probe/status/audit', within: 'main' },
  { path: '/admin?all' },
  { path: '/admin/logout' },
  { path: '/admin/login' },
  { path: '/admin/voorkeuren' },
  { path: '/admin/probe/profiel', within: 'main' },
  { path: '/admin/probe/content?type=page' },
  { path: '/admin/probe/content/new' },
  ...['overview', 'overview?view=list', 'detail', 'edit', 'settings', 'form', 'states'].map(
    (pattern) => ({ path: `/admin/probe/_ui/${pattern}`, folds: true })
  ),
];

/** Public routes of the probe site, measured anonymously in Dutch. */
export const PUBLIC_ROUTES: GateRoute[] = [{ path: '/probe/campagne' }, { path: '/probe/artikel' }];

export const ADMIN_LOCALES = ['nl-NL', 'en-GB'] as const;
