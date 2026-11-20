// The tenant's switch for managed integrations (docs/reference/integrations.md). Switching one on
// decides which third party's code runs on the public site and what its visitors' browsers
// contact, which is a site administrator's decision (`tenant:admin`), like the measurement
// setting. The public site gets one narrow read with only the switched-on entries, so a parameter
// of a switched-off entry never reaches a page.
// Rejected: a `site.integrations.*` pair (the module owns its catalogue and decision, like
// `analytics.settings`), and one use case per integration (one form and one version cover the
// whole catalogue; per-entry writes would race each other's version).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import './ports.js';
import {
  DEFAULT_INTEGRATIONS,
  IntegrationPlacement,
  IntegrationSettings,
  placementOf,
} from './model.js';

const version = z.number().int().nonnegative();

export const getIntegrationSettings = defineUseCase({
  name: 'integration.settings.get',
  kind: 'query',
  description:
    "Read which managed integrations (YouTube, Vimeo, Google Tag Manager) this site has switched on, with each one's parameters.",
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: z.object({ version, value: IntegrationSettings }),
  examples: [{ input: {} }],
  handler: (ctx) => ctx.integrationSettings.get(),
});

export const updateIntegrationSettings = defineUseCase({
  name: 'integration.settings.update',
  kind: 'command',
  description:
    'Switch managed integrations on or off and set their parameters, at a known version; switching one off stops it on the public site from the next request on.',
  requires: 'tenant:admin',
  input: z.object({ baseVersion: version, settings: IntegrationSettings }).strict(),
  output: z.object({ version, value: IntegrationSettings }),
  examples: [
    {
      input: {
        baseVersion: 0,
        settings: { ...DEFAULT_INTEGRATIONS, youtube: { enabled: true } },
      },
    },
    {
      input: {
        baseVersion: 1,
        settings: {
          ...DEFAULT_INTEGRATIONS,
          'google-tag-manager': {
            enabled: true,
            containerId: 'GTM-ABC123',
            category: 'marketing',
            vendors: ['meta-pixel'],
          },
        },
      },
    },
  ],
  handler: async (ctx, { baseVersion, settings }) => {
    const next = await ctx.integrationSettings.update(baseVersion, settings);
    if (next === null) throw new UseCaseError('conflict', 'integration.settings.conflict');
    return { version: next, value: settings };
  },
});

/**
 * The public site's read: the switched-on embeds and tag manager, nothing switched off. Anonymous,
 * because every value in it is visible in a page that uses it.
 */
export const getIntegrationPlacement = defineUseCase({
  name: 'integration.placement.get',
  kind: 'query',
  description:
    'Read which managed integrations this public site places: the switched-on embeds and the tag manager container, if any.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: IntegrationPlacement,
  examples: [{ input: {} }],
  handler: async (ctx) => placementOf((await ctx.integrationSettings.get()).value),
});
