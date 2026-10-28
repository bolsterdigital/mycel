// The routes of the generic UI gate (ui-gate.spec.ts): pages whose state the seed of
// scripts/e2e.mjs already holds, so the gate only opens them. A route that needs state a flow
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
}

/** Admin routes, measured signed in as the seeded tenant admin in both admin locales. */
export const ADMIN_ROUTES: GateRoute[] = [
  { path: '/admin/probe', within: 'main' },
  { path: '/admin/probe/content?type=page' },
  { path: '/admin/probe/content/new' },
  ...['overview', 'overview?view=list', 'detail', 'edit', 'settings', 'form', 'states'].map(
    (pattern) => ({ path: `/admin/probe/_ui/${pattern}`, folds: true })
  ),
];

/** Public routes of the probe site, measured anonymously in Dutch. */
export const PUBLIC_ROUTES: GateRoute[] = [{ path: '/probe/campagne' }, { path: '/probe/artikel' }];

export const ADMIN_LOCALES = ['nl-NL', 'en-GB'] as const;
