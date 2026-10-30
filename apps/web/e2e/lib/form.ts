// The probe form refuses a post that comes sooner than `minFillSeconds` after it was rendered
// (core forms/spam.ts: a bot fills a form at once). The rendered form carries the start time in
// its signed `_started` token, `base64url(payload).mac` with `{ f, t }` (packages/api/src/
// signer.ts), so a spec waits exactly until that moment instead of a fixed pause; the browser
// and the server share the machine's clock.
// Rejected: `expect.poll` (nothing in the page changes when the time has passed) and a fixed
// `waitForTimeout` of 3200 ms in each spec, which drifts from the form's setting.

import type { Page } from '@playwright/test';
import { probeForm } from '@mycel/core/testing';

/** What the seeded probe form waits (scripts/e2e.mjs seeds `probeForm`). */
const MIN_FILL_MS = probeForm('e2e').minFillSeconds * 1000;
/** Margin for the time between this check and the server reading its clock. */
const MARGIN_MS = 100;

/** When the form whose `_started` token is `token` may be posted, in epoch milliseconds. */
export function postableAt(token: string): number {
  const segment = token.slice(0, token.indexOf('.'));
  const { t } = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as { t: number };
  return t + MIN_FILL_MS + MARGIN_MS;
}

/**
 * Waits until the form on `page` (or the one whose `_started` token is given) may be posted.
 * With several forms on the page, the first one's token counts.
 */
export async function pastMinimumFillTime(source: Page | string): Promise<void> {
  const token =
    typeof source === 'string'
      ? source
      : await source.locator('input[name="_started"]').first().inputValue();
  const wait = postableAt(token) - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
