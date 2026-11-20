// The tenant opt-in for measurement (docs/reference/analytics.md). Setting and reading the full setting is a site
// administrator's decision (`tenant:admin`): it decides what a third party learns about the
// site's visitors, which no editor capability covers. The public site gets one narrow read that
// returns the identifier and nothing else, so a later field on the setting cannot leak through it.
// Rejected: a `site.analytics.*` pair (the module owns its catalogue, port and subscriber, like
// `assist.settings`), and folding the identifier into `site.general` (written with
// `content:write`, so an editor could switch a tracker on).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import '../tenants/ports.js';
import './ports.js';
import { AnalyticsSettings, DEFAULT_ANALYTICS, PlausibleDomain } from './model.js';

const version = z.number().int().nonnegative();

/**
 * The setting with what an operator needs to judge it: the site's primary hostname and whether
 * the configured Plausible site still matches it. A hostname change never rewrites the setting;
 * `hostnameMismatch` is how the admin shows that it may need correcting. `www.` on either side
 * counts as the same site, as Plausible's own site names usually drop it.
 */
const SettingsState = z.object({
  version,
  value: AnalyticsSettings,
  primaryHostname: z.string().nullable(),
  hostnameMismatch: z.boolean(),
});

export function sameSite(domain: string, hostname: string): boolean {
  const bare = (value: string) => value.toLowerCase().replace(/^www\./, '');
  return bare(domain) === bare(hostname);
}

export const getAnalyticsSettings = defineUseCase({
  name: 'analytics.settings.get',
  kind: 'query',
  description:
    "Read this site's measurement setting: the Plausible site its counts go to (null: none), and whether it still matches the primary hostname.",
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: SettingsState,
  examples: [{ input: {} }],
  handler: async (ctx) => {
    const [state, primary] = await Promise.all([
      ctx.analyticsSettings.get(),
      ctx.hostnames.primary(),
    ]);
    const domain = state.value.plausibleDomain;
    const hostname = primary?.hostname ?? null;
    return {
      ...state,
      primaryHostname: hostname,
      hostnameMismatch: domain !== null && hostname !== null && !sameSite(domain, hostname),
    };
  },
});

export const updateAnalyticsSettings = defineUseCase({
  name: 'analytics.settings.update',
  kind: 'command',
  description:
    'Set or clear the Plausible site this site counts pageviews and accepted signups to, at a known version; null stops all measurement from the next request on and does not erase what Plausible already holds.',
  requires: 'tenant:admin',
  input: z.object({ baseVersion: version, settings: AnalyticsSettings }).strict(),
  output: z.object({ version, value: AnalyticsSettings }),
  examples: [
    { input: { baseVersion: 0, settings: { plausibleDomain: 'example.org' } } },
    { input: { baseVersion: 1, settings: DEFAULT_ANALYTICS } },
  ],
  handler: async (ctx, { baseVersion, settings }) => {
    const next = await ctx.analyticsSettings.update(baseVersion, settings);
    if (next === null) throw new UseCaseError('conflict', 'analytics.settings.conflict');
    return { version: next, value: settings };
  },
});

/**
 * The public site's read: the identifier when measurement is on, null otherwise. The script gate
 * (PR 2) and nothing else needs it; it is readable with `content:read` because the identifier is
 * in every counted page anyway.
 */
export const getAnalyticsTracker = defineUseCase({
  name: 'analytics.tracker.get',
  kind: 'query',
  description:
    'Read the Plausible site this public site counts pageviews to, or null when measurement is off.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: z.object({ plausibleDomain: PlausibleDomain.nullable() }).strict(),
  examples: [{ input: {} }],
  handler: async (ctx) => ({
    plausibleDomain: (await ctx.analyticsSettings.get()).value.plausibleDomain,
  }),
});
