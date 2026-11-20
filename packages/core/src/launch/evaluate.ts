// The checks of the launch checklist as pure functions over facts the service has already read
// (ADR 037 rule 3): no port, no clock, no external call, so each is tested with a fixture and the
// read costs a fixed number of queries whatever the outcome. A check says `warn` where a site may
// deliberately differ (no statistics, an unverified second domain) and `fail` only where going
// live would visibly break something: no home page, nobody to run the site, payments that cannot
// be taken, a domain that does not serve.

import type { CheckOutcome } from './model.js';
import type { LaunchCheck } from './steps.js';

export interface LaunchFacts {
  home: {
    /** Locales the home page (`page` with slug `index`) has; empty when there is none. */
    locales: readonly string[];
    /** Of those, the ones that are published. */
    published: readonly string[];
  };
  members: readonly { role: 'author' | 'editor' | 'admin' | 'custom'; pending: boolean }[];
  forms: readonly { id: string; label: string | null; notifies: boolean }[];
  /** The Mollie connection, if the site has one, and the mode of its stored key (MY-262 PR 3). */
  mollie: { connected: boolean; mode: 'test' | 'live' | null } | null;
  analytics: { domain: string | null; hostnameMismatch: boolean };
  hostnames: readonly {
    hostname: string;
    kind: 'platform' | 'custom';
    primary: boolean;
    verified: boolean;
  }[];
  /** What the status page counts as asking for an administrator (`judgeOps`). */
  ops: { jobs: number; mails: number; erasures: number };
}

const ok = (code: string): CheckOutcome => ({ result: 'pass', detail: { code } });

function homePublished({ home }: LaunchFacts): CheckOutcome {
  if (!home.published.length)
    return {
      result: 'fail',
      detail: {
        code: home.locales.length ? 'home-published.unpublished' : 'home-published.missing',
      },
    };
  const missing = home.locales.filter((l) => !home.published.includes(l));
  return missing.length
    ? {
        result: 'warn',
        detail: { code: 'home-published.partly', params: { locales: missing.join(', ') } },
      }
    : ok('home-published.ok');
}

function teamReady({ members }: LaunchFacts): CheckOutcome {
  const active = members.filter((m) => !m.pending && (m.role === 'admin' || m.role === 'editor'));
  if (!active.length) return { result: 'fail', detail: { code: 'team-ready.nobody' } };
  const pending = members.filter((m) => m.pending).length;
  return pending
    ? { result: 'warn', detail: { code: 'team-ready.pending', params: { count: String(pending) } } }
    : ok('team-ready.ok');
}

function formNotifications({ forms }: LaunchFacts): CheckOutcome {
  const silent = forms.filter((f) => !f.notifies);
  if (!forms.length) return ok('form-notifications.none');
  return silent.length
    ? {
        result: 'warn',
        detail: {
          code: 'form-notifications.silent',
          params: { count: String(silent.length) },
          subjects: silent.map((f) => ({ id: f.id, label: f.label })),
        },
      }
    : ok('form-notifications.ok');
}

function paymentsConnected({ mollie }: LaunchFacts): CheckOutcome {
  if (!mollie) return { result: 'fail', detail: { code: 'payments-connected.missing' } };
  return mollie.connected
    ? ok('payments-connected.ok')
    : { result: 'fail', detail: { code: 'payments-connected.attention' } };
}

/**
 * A test key takes no real gift, so it fails on the day itself. A key stored before Mycel kept
 * its mode warns: saving it again tells (clean cut, no conversion of stored keys).
 */
function mollieLive({ mollie }: LaunchFacts): CheckOutcome {
  if (!mollie) return { result: 'fail', detail: { code: 'mollie-live.missing' } };
  if (mollie.mode === 'live') return ok('mollie-live.ok');
  return mollie.mode === 'test'
    ? { result: 'fail', detail: { code: 'mollie-live.test' } }
    : { result: 'warn', detail: { code: 'mollie-live.unknown' } };
}

function analytics({ analytics: a }: LaunchFacts): CheckOutcome {
  if (a.domain === null) return { result: 'warn', detail: { code: 'analytics.off' } };
  return a.hostnameMismatch
    ? { result: 'warn', detail: { code: 'analytics.mismatch', params: { domain: a.domain } } }
    : ok('analytics.ok');
}

function customDomain({ hostnames }: LaunchFacts): CheckOutcome {
  const custom = hostnames.filter((h) => h.kind === 'custom');
  if (!custom.length) return { result: 'fail', detail: { code: 'custom-domain.missing' } };
  const primary = custom.find((h) => h.primary);
  if (primary && !primary.verified)
    return {
      result: 'fail',
      detail: { code: 'custom-domain.unverified', params: { hostname: primary.hostname } },
    };
  if (primary)
    return {
      result: 'pass',
      detail: { code: 'custom-domain.ok', params: { hostname: primary.hostname } },
    };
  const verified = custom.find((h) => h.verified);
  return verified
    ? {
        result: 'warn',
        detail: { code: 'custom-domain.not-primary', params: { hostname: verified.hostname } },
      }
    : {
        result: 'fail',
        detail: { code: 'custom-domain.unverified', params: { hostname: custom[0]!.hostname } },
      };
}

function opsHealthy({ ops }: LaunchFacts): CheckOutcome {
  const params = Object.fromEntries(
    Object.entries(ops)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => [kind, String(n)])
  );
  return Object.keys(params).length
    ? { result: 'warn', detail: { code: 'ops-healthy.attention', params } }
    : ok('ops-healthy.ok');
}

export const LAUNCH_CHECKS: Readonly<Record<LaunchCheck, (facts: LaunchFacts) => CheckOutcome>> = {
  'home-published': homePublished,
  'team-ready': teamReady,
  'form-notifications': formNotifications,
  'payments-connected': paymentsConnected,
  'mollie-live': mollieLive,
  analytics,
  'custom-domain': customDomain,
  'ops-healthy': opsHealthy,
};
