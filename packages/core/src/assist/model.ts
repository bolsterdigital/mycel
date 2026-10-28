// The worker and fronts share one bounded, content-free view of a suggestion. The actual result
// stays in a tenant-owned row until an editor accepts or retention removes it.

import { z } from 'zod';

/** A pending proposal older than this has timed out; it also bounds the pending throttle. */
export const PENDING_TIMEOUT_MS = 600_000;

export const AltResult = z
  .object({
    alt: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .regex(/^[^\r\n]+$/),
  })
  .strict();

export const SettingsView = z.object({
  enabled: z.boolean(),
  allowRestricted: z.boolean(),
  consentedProvider: z.string().nullable(),
  consentedBy: z.string().nullable(),
  consentedAt: z.string().datetime({ offset: true }).nullable(),
  provider: z.string().nullable(),
});

export const SuggestionView = z.object({
  id: z.string().guid(),
  itemId: z.string().guid(),
  baseRevisionId: z.string().guid(),
  blockId: z.string(),
  locale: z.string(),
  status: z.enum(['pending', 'ready', 'failed', 'accepted', 'dismissed']),
  value: z.string().nullable(),
  failure: z.enum(['unavailable', 'timeout', 'rejected', 'invalid-output']).nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
