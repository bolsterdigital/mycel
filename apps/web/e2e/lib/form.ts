// The probe form refuses a post that comes sooner than `minFillSeconds` after it was rendered
// (core forms/spam.ts: a bot fills a form at once). The rendered form carries the start time in
// its signed `_started` token, `base64url(payload).mac` with `{ f, t }` (packages/api/src/
// signer.ts), so a spec waits exactly until that moment instead of a fixed pause; the browser
// and the server share the machine's clock.
// Rejected: `expect.poll` (nothing in the page changes when the time has passed) and a fixed
// `waitForTimeout` of 3200 ms in each spec, which drifts from the form's setting.

import type { Page } from '@playwright/test';
import { probeForm } from '@mycel/core/testing';

/** What the seeded probe form waits (scripts/e2e/e2e.mjs seeds `probeForm`). */
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

// Public form fields as a phone meets them (checklist item mobile-form-inputs): every text entry
// field is at least 16 CSS px, so iOS Safari does not zoom in on focus; it names what it asks for
// in `autocomplete`, so the browser can fill it; and its `type` matches that token, so the phone
// shows the matching keyboard. Measured in the browser on the rendered page, because the font size
// is the theme's and only the cascade knows it. Fields a visitor cannot reach (the honeypot under
// `aria-hidden`, anything not rendered) do not count.
// Rejected: a source rule over Form.svelte. It would see the markup but not the theme's font size,
// and a new form renderer would slip past it.
/** One line per field that breaks a rule, and one when the page has no field at all. */
export function mobileInputProblems(page: Page, within = 'main'): Promise<string[]> {
  return page.evaluate((root) => {
    // Types that open no keyboard: they need no autocomplete token and no minimum text size.
    const keyless = new Set(
      'hidden submit button reset image checkbox radio file range color'.split(' ')
    );
    // The autocomplete token that asks for a keyboard of its own, and the type that brings it.
    const typeFor = (token: string) =>
      token === 'email' ? 'email' : token.startsWith('tel') ? 'tel' : token === 'url' ? 'url' : '';
    const problems: string[] = [];
    const fields = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `${root} form :is(input, textarea, select)`
      ),
    ].filter(
      (el) =>
        !(el instanceof HTMLInputElement && keyless.has(el.type)) &&
        !el.closest('[aria-hidden="true"], [hidden]') &&
        el.getClientRects().length > 0
    );
    if (fields.length === 0) problems.push(`no text entry field in a form within ${root}`);
    for (const el of fields) {
      const name = el.name || el.id || el.tagName.toLowerCase();
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) problems.push(`${name}: font-size ${size}px, below 16px`);
      const tokens = (el.getAttribute('autocomplete') ?? '').trim().split(/\s+/).filter(Boolean);
      const token = tokens.at(-1) ?? '';
      if (!token) problems.push(`${name}: no autocomplete`);
      if (!(el instanceof HTMLInputElement)) continue;
      const wanted = typeFor(token) || (/e-?mail/i.test(el.name) ? 'email' : '');
      if (wanted && el.type !== wanted)
        problems.push(`${name}: type ${el.type}, ${wanted} expected for "${token || el.name}"`);
    }
    return problems;
  }, within);
}
