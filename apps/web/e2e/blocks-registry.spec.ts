// Browser axe over every block example in the registry (TODO #30B, brief renderer-regressions
// § B). scripts/e2e.mjs publishes one page per example of `BLOCK_DEFINITIONS`, slug
// `blok-<example name>`, in nl and en, with the example ids swapped for real seeded data; this
// spec walks the same registry. A new example or variant is therefore in the browser gate the
// moment it is in the registry: there is no second list to keep in step. Per example and locale:
// the page renders, ships no script but a form's proof-of-work module, and passes axe (WCAG 2.2 AA tags) in the `a11y` project.
//
// An example that renders nothing on purpose is named in INVISIBLE with its reason, and the check
// runs both ways: a visible example must put something in `main` besides the title, an invisible
// one must not. So a broken fixture (an id that did not resolve renders nothing too) fails here
// instead of passing axe on an empty page, and a new invisible example must be named.
//
// The composed pages, the no-JS behaviour and the UI gate at 320 px and 200% stay in
// blocks.spec.ts: they test blocks next to each other, this tests each one alone.
// Rejected: one page with every example on it (four forms with the same form id would share
// element ids, and one failing block would hide the rest), and a hand-picked fixture list (the
// drift this replaces).

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { BLOCK_DEFINITIONS, BLOCK_TYPES } from '@mycel/core';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Examples that render nothing for an anonymous visitor, with the reason. */
const INVISIBLE: Record<string, string> = {
  paywall: 'the teaser boundary of ADR 016 renders no markup of its own (#19)',
};

const examples = BLOCK_TYPES.flatMap((type) => BLOCK_DEFINITIONS[type].examples.map((e) => e.name));

test.use({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

test('every invisible example exists in the registry', () => {
  expect(Object.keys(INVISIBLE).filter((name) => !examples.includes(name))).toEqual([]);
});

for (const name of examples)
  for (const locale of ['nl', 'en'] as const)
    test(`${name} (${locale}) renders alone and passes axe`, async ({ page }) => {
      const path = locale === 'nl' ? `/probe/blok-${name}` : `/probe/en/blok-${name}`;
      const response = await page.goto(path, { waitUntil: 'load' });
      expect(response?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      // Only a form's own proof-of-work module (brief form-intake § D2.3).
      expect(await page.locator('script:not([src="/_form/proof.js"])').count()).toBe(0);
      const rendered = await page.locator('main > :not(h1)').count();
      if (name in INVISIBLE) expect(rendered, INVISIBLE[name]).toBe(0);
      else expect(rendered, `${name} rendered nothing`).toBeGreaterThan(0);
      if (test.info().project.name !== 'a11y') return;
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      ).toEqual([]);
    });
