// Public form fields as a phone meets them (checklist item mobile-form-inputs): every text entry
// field is at least 16 CSS px, so iOS Safari does not zoom in on focus; it names what it asks for
// in `autocomplete`, so the browser can fill it; and its `type` matches that token, so the phone
// shows the matching keyboard. Measured in the browser on the rendered page, because the font size
// is the theme's and only the cascade knows it. Fields a visitor cannot reach (the honeypot under
// `aria-hidden`, anything not rendered) do not count.
// Rejected: a source rule over Form.svelte. It would see the markup but not the theme's font size,
// and a new form renderer would slip past it.

import type { Page } from '@playwright/test';

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
