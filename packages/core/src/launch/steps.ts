// The launch checklist's steps (MY-262, ADR 037 rule 1): one register in code, the same for every
// site, so an improvement to the checklist reaches every site with a deploy. A site stores only
// the state of a step (ports.ts), never its definition. Titles and explanations live in the admin
// catalog under `admin.launch.step.<id>`, not here. Modelled on Dreamkit's `wings-launch`, without
// its WordPress-only steps (cache drop-ins, Gravity Forms currency, staging gate).
// Rejected: steps as rows a platform maintainer edits per installation (every site would drift
// from the next release's list, which is what the code register prevents), and site-specific
// extra steps (a note on a step covers that until a site asks; brief, "Niet in deze brief").

import { z } from 'zod';

/** Preparation, the day itself, and the week after; only the first two decide "ready". */
export const LaunchPhase = z.enum(['prepare', 'launch', 'after']);
export type LaunchPhase = z.infer<typeof LaunchPhase>;

/** Who does it: whoever hosts the installation, the organisation the site is for, or both. */
export const LaunchOwner = z.enum(['platform', 'organisation', 'shared']);
export type LaunchOwner = z.infer<typeof LaunchOwner>;

/**
 * A step that only applies with a feature: it is not applicable while the site's entitlement is
 * off (ADR 037 rule 4), so a site without donations never waits on a test donation.
 */
export const LaunchGroup = z.enum(['giving', 'mailing', 'domain']);
export type LaunchGroup = z.infer<typeof LaunchGroup>;

/** The steps Mycel can establish itself; each has an evaluation in `evaluate.ts`. */
export const LaunchCheck = z.enum([
  'home-published',
  'team-ready',
  'form-notifications',
  'payments-connected',
  'analytics',
  'custom-domain',
  'ops-healthy',
]);
export type LaunchCheck = z.infer<typeof LaunchCheck>;

export interface LaunchStepDefinition {
  id: string;
  phase: LaunchPhase;
  owner: LaunchOwner;
  group?: LaunchGroup;
  /** Present on a step Mycel evaluates; without it the step is ticked by hand. */
  check?: LaunchCheck;
}

const step = (
  id: string,
  phase: LaunchPhase,
  owner: LaunchOwner,
  extra: Pick<LaunchStepDefinition, 'group' | 'check'> = {}
): LaunchStepDefinition => ({ id, phase, owner, ...extra });

/** In display order within each phase. A step id never changes meaning once released. */
export const LAUNCH_STEPS: readonly LaunchStepDefinition[] = [
  step('home-published', 'prepare', 'organisation', { check: 'home-published' }),
  step('team-ready', 'prepare', 'organisation', { check: 'team-ready' }),
  step('form-notifications', 'prepare', 'shared', { check: 'form-notifications' }),
  step('payments-connected', 'prepare', 'platform', {
    group: 'giving',
    check: 'payments-connected',
  }),
  step('test-donation', 'prepare', 'organisation', { group: 'giving' }),
  step('newsletter-signup-tested', 'prepare', 'organisation', { group: 'mailing' }),
  step('analytics', 'prepare', 'platform', { check: 'analytics' }),
  step('consent-banner', 'prepare', 'platform'),
  step('content-reviewed', 'prepare', 'shared'),
  step('redirects', 'prepare', 'shared'),
  step('content-freeze', 'prepare', 'organisation'),
  step('old-platform-export', 'prepare', 'organisation'),
  step('dns-ttl-lowered', 'prepare', 'organisation', { group: 'domain' }),
  step('backup', 'prepare', 'platform'),

  step('go-no-go', 'launch', 'organisation'),
  step('dns-cutover', 'launch', 'organisation', { group: 'domain' }),
  step('custom-domain', 'launch', 'shared', { group: 'domain', check: 'custom-domain' }),
  step('mollie-live', 'launch', 'organisation', { group: 'giving' }),
  step('live-test-payment', 'launch', 'shared', { group: 'giving' }),
  step('ops-healthy', 'launch', 'platform', { check: 'ops-healthy' }),

  step('smoke-test', 'after', 'shared'),
  step('broken-links', 'after', 'platform'),
  step('search-console', 'after', 'organisation'),
  step('analytics-verified', 'after', 'organisation'),
  step('dns-ttl-restored', 'after', 'organisation', { group: 'domain' }),
  step('launch-mail', 'after', 'platform'),
];

/** The form of a step id, as the table's check enforces it (0085). */
export const LaunchStepId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);

export const launchStep = (id: string): LaunchStepDefinition | undefined =>
  LAUNCH_STEPS.find((s) => s.id === id);
