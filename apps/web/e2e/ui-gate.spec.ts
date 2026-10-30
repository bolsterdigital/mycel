// flow: none, the generic gate (testing.md § End-to-end flows)
// Layout and accessibility that do not belong to one flow: the routes of routes.ts at 320 CSS px
// and 200% text, the admin component catalogue and every block example of the registry alone.
// A flow spec gates only the state it makes itself.

import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  UseCaseError,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { type Page, expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { forwarded, login } from './lib/login';
import { ADMIN_LOCALES, ADMIN_ROUTES, type GateRoute, PUBLIC_ROUTES } from './routes';
import { isA11y, onlyA11y } from './lib/project';

// The generic gate over routes.ts: every route at 320 CSS px in default and 200% text passes
// lib/layout.ts, and axe in the a11y project. One login per locale and text size walks every
// admin route, so a new route costs one line, not a spec.
test.describe('ui-gate', () => {
  test.use({ viewport: NARROW });

  const measure = async (page: Page, route: GateRoute, text: string) => {
    if (route.menu) await page.locator('.admin-menu > summary').click();
    if (route.folds) {
      const folds = page.locator('.ui-fold > summary');
      for (let i = 0; i < (await folds.count()); i++) await folds.nth(i).click();
    }
    await setTextSize(page, text);
    await layoutGate(page, `${route.path} at ${text}`, route.within);
    if (text === '100%') await expectNoAxeViolations(page, { label: route.path });
  };

  for (const locale of ADMIN_LOCALES)
    test.describe(`admin routes, ${locale}`, () => {
      test.use({ locale });
      for (const text of TEXT_SIZES)
        test(`every admin route at ${text} text`, async ({ page }) => {
          onlyA11y('measures the layout with a script');
          await login(page, ADMIN_ROUTES[0]!.path, undefined, { 'accept-language': locale });
          for (const route of ADMIN_ROUTES) {
            expect((await page.goto(route.path))?.status(), route.path).toBe(200);
            await measure(page, route, text);
          }
        });
    });

  test.describe('public routes', () => {
    test.use({ locale: 'nl-NL', extraHTTPHeaders: forwarded() });
    for (const text of TEXT_SIZES)
      test(`every public route at ${text} text`, async ({ page }) => {
        onlyA11y('measures the layout with a script');
        for (const route of PUBLIC_ROUTES) {
          expect((await page.goto(route.path))?.status(), route.path).toBe(200);
          await measure(page, route, text);
        }
      });
  });
});

// The admin component catalogue (brief #56 PR 1 and 2) is the UI gate of lib/admin/ui: every
// component and every page pattern with the longest real labels, measured at 320 CSS px and 200%
// text in both admin locales (skill ui-action-layout), axe in the light and the dark scheme, and
// the dialog opened and closed without JavaScript. Only `tenant:admin` sees it. A screen built from these components inherits the measurements; its own
// spec still checks its own content.
test.describe('admin-ui', () => {
  const email = 'ui-catalogue@probe.test';
  const editor = 'ui-catalogue-editor@probe.test';
  const PATTERNS = ['overview', 'detail', 'edit', 'settings', 'form', 'states'] as const;

  test.beforeAll(async () => {
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      for (const [who, capabilities] of [
        [email, ['tenant:admin']],
        [editor, ['media:read']],
      ] as const)
        try {
          await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
            email: who,
            capabilities: [...capabilities],
          });
        } catch (e) {
          if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
        }
    });
  });

  const open = (page: Page, path = '/admin/probe/_ui', as = email) => login(page, path, as);

  test('renders every component once', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Interface components');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
    await expect(page.locator('.ui-notice')).toHaveCount(4);
    await expect(page.getByRole('alert')).toContainText('could not be uploaded');
    await expect(page.getByLabel(/^Title/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('radio', { name: 'Public' })).toBeChecked();
    await expect(page.locator('input[type="file"].ui-filedrop')).toHaveCount(1);
    await expect(page.locator('.ui-card-grid > li')).toHaveCount(3);
    await expect(
      page
        .getByRole('navigation', { name: 'Sub-navigation' })
        .getByRole('link', { name: 'General' })
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('2 of 5');
    // Text in the colour of its own background passes axe as "incomplete"; it happened when base.css
    // won the cascade over the components (layer order, admin.css).
    expect(
      await page.locator('.ui-button, .ui-badge, .ui-notice').evaluateAll((nodes) =>
        nodes
          .filter((node) => {
            const style = getComputedStyle(node);
            return style.color === style.backgroundColor;
          })
          .map((node) => node.textContent?.trim())
      )
    ).toEqual([]);
    if (!isA11y()) {
      // The catalogue holds what screens will hold: no script but KeyReveal's copy enhancement.
      await expect(page.locator('script:not([src="/_admin/copy.js"])')).toHaveCount(0);
      return;
    }
    await expectNoAxeViolations(page, { dark: true });
  });

  test('sorts the table through links', async ({ page }) => {
    await open(page);
    const table = page.getByRole('table', { name: 'Recently changed files' });
    await expect(table.locator('tbody tr').first()).toContainText('annual-report.pdf');
    await expect(table.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    await table.getByRole('link', { name: /Name/ }).click();
    await expect(page).toHaveURL(/sort=name&dir=desc/);
    await expect(table.locator('tbody tr').first()).toContainText('volunteers-at-the-market.webp');
    await expect(table.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  test('opens and closes the dialog without a script', async ({ page }) => {
    await open(page);
    const trigger = page.getByRole('button', { name: 'View full size' });
    const dialog = page.getByRole('dialog', { name: 'annual-report.pdf' });
    await expect(dialog).toBeHidden();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  for (const locale of ['en-GB', 'nl-NL']) {
    test.describe(`at 320 CSS px and 200% text, ${locale}`, () => {
      test.use({ locale, viewport: NARROW });
      test('keeps every label whole and nothing scrolls sideways', async ({ page }) => {
        await open(page);
        await setTextSize(page, '200%');
        await page.locator('.ui-fold:not(.ui-confirm) > summary').click();
        await layoutGate(page, 'catalogue');
        // Each stacking group stands in one column: every button as wide as its group.
        const widths = await page
          .locator('.ui-actions.stack')
          .evaluateAll((groups) =>
            groups.map(
              (group) =>
                new Set(
                  [...group.querySelectorAll('.ui-button')].map((node) =>
                    Math.round(node.getBoundingClientRect().width)
                  )
                ).size
            )
          );
        expect(widths.length).toBeGreaterThan(1);
        expect(widths.every((n) => n === 1)).toBe(true);
        const trigger = page.locator('[command="show-modal"]');
        await trigger.click();
        await layoutGate(page, 'catalogue with the dialog open');
      });
    });
  }

  test('is refused to a member without tenant:admin, patterns included', async ({ page }) => {
    await open(page, '/admin/probe/_ui', editor);
    expect((await page.reload())!.status()).toBe(403);
    expect((await page.goto('/admin/probe/_ui/overview'))!.status()).toBe(403);
  });

  test('the catalogue links every page pattern', async ({ page }) => {
    await open(page);
    const list = page.locator('section', {
      has: page.getByRole('heading', { name: 'Page patterns' }),
    });
    await expect(list.getByRole('link')).toHaveCount(PATTERNS.length);
    expect((await page.goto('/admin/probe/_ui/unknown'))!.status()).toBe(404);
  });

  for (const pattern of PATTERNS)
    test(`the ${pattern} pattern: one h1, no script, axe light and dark`, async ({ page }) => {
      await open(page, `/admin/probe/_ui/${pattern}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('script')).toHaveCount(0);
      if (!isA11y()) return;
      await expectNoAxeViolations(page, { dark: true });
    });

  test('a settings section confirms its own save, without a script', async ({ page }) => {
    await open(page, '/admin/probe/_ui/settings');
    const contact = page.locator('section', {
      has: page.getByRole('heading', { name: 'Contact address for supporters' }),
    });
    await contact.getByRole('button', { name: 'Save details' }).click();
    await expect(contact.getByRole('status')).toContainText('Changes saved.');
    const general = page.locator('section', {
      has: page.getByRole('heading', { name: 'Name and languages' }),
    });
    await expect(general.getByRole('status')).toHaveCount(0);
  });
});

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
// The composed pages and their no-JS behaviour are in public-site.spec.ts: blocks next to each
// other there, each one alone here.
// Rejected: one page with every example on it (four forms with the same form id would share
// element ids, and one failing block would hide the rest), and a hand-picked fixture list (the
// drift this replaces).
test.describe('blocks-registry', () => {
  /** Examples that render nothing for an anonymous visitor, with the reason. */
  const INVISIBLE: Record<string, string> = {
    paywall: 'the teaser boundary of ADR 016 renders no markup of its own (#19)',
  };

  const examples = BLOCK_TYPES.flatMap((type) =>
    BLOCK_DEFINITIONS[type].examples.map((e) => e.name)
  );

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
        await expectNoAxeViolations(page);
      });

  for (const variant of ['list', 'accordion'] as const)
    for (const width of ['content', 'wide', 'full'] as const)
      for (const locale of ['nl', 'en'] as const)
        test(`FAQ ${variant} ${width} ${locale} keeps readable rails and native disclosure`, async ({
          page,
        }) => {
          const name = `faq-${variant}${width === 'content' ? '' : `-${width}`}`;
          const path = `/probe/${locale === 'en' ? 'en/' : ''}blok-${name}`;
          for (const viewport of [320, 768, 1440]) {
            await page.setViewportSize({ width: viewport, height: 900 });
            expect((await page.goto(path))?.status()).toBe(200);
            if (viewport === 320) await setTextSize(page, '200%');
            const section = page.locator(`main > .faq.width-${width}`);
            await expect(section).toBeVisible();
            const dimensions = await page.evaluate(() => {
              const section = document.querySelector('main > .faq')!;
              const answer = section.querySelector('.answer')!;
              const box = (element: Element) => element.getBoundingClientRect();
              return {
                viewport: document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth,
                section: box(section).width,
                answer: box(answer).width,
                summary: section.querySelector('summary')
                  ? box(section.querySelector('summary')!).height
                  : null,
              };
            });
            expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport + 1);
            expect(dimensions.answer).toBeLessThanOrEqual(dimensions.section);
            if (viewport === 1440 && width === 'wide') expect(dimensions.section).toBe(1088);
            if (viewport === 1440 && width === 'full') expect(dimensions.section).toBe(1440);
            if (variant === 'accordion') {
              expect(dimensions.summary).toBeGreaterThanOrEqual(44);
              await page.locator('summary').focus();
              await page.keyboard.press('Enter');
              await expect(page.locator('details')).toHaveAttribute('open', '');
              await expect(page.locator('.faq .answer')).toBeVisible();
            }
            if (viewport === 320)
              await page.screenshot({
                path: test.info().outputPath(`${name}-${locale}-320-text200.png`),
                fullPage: true,
              });
          }
        });
});
