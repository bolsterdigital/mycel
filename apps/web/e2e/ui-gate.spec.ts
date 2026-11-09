// flow: none, the generic gate (testing.md § End-to-end flows)
// Layout and accessibility that do not belong to one flow: the routes of routes.ts at 320 CSS px
// and 200% text, the admin component catalogue, every block example of the registry alone, and the
// tenant shell that every admin route shares.
// A flow spec gates only the state it makes itself.

import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  UseCaseError,
  systemPrincipal,
  useCases,
  Invoker,
  capabilitiesFor,
} from '@mycel/core';
import { type Page, expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { tenantId, withInvoker, asOwner } from './lib/invoker';
import { NARROW, TEXT_SIZES, focusObscuredProblems, layoutGate, setTextSize } from './lib/layout';
import { forwarded, login } from './lib/login';
import { ADMIN_LOCALES, ADMIN_ROUTES, type GateRoute, PUBLIC_ROUTES } from './routes';
import { OTHER_SCRIPTS, isA11y, onlyA11y } from './lib/project';
import { testTenant } from '@mycel/db/testing';
import { callApi, requireApi } from './lib/api';

// The generic gate over routes.ts: every route at 320 CSS px in default and 200% text passes
// lib/layout.ts, and axe in the a11y project. One login per locale and text size walks every
// admin route, so a new route costs one line, not a spec.
test.describe('ui-gate', () => {
  test.use({ viewport: NARROW });

  const measure = async (page: Page, route: GateRoute, text: string) => {
    if (route.menu) {
      await page.locator('.admin-menu > summary').click();
      for (const summary of await page.locator('.admin-account:not([open]) > summary').all())
        await summary.click();
      const closedGroups = page.locator('.ui-navgroup-disclosure:not([open]) > summary');
      while (await closedGroups.count()) await closedGroups.first().click();
    }
    if (route.folds) {
      const folds = page.locator('.ui-fold > summary');
      // A fold inside a closed dialog (the role picker's advanced part, #101) is not on the page
      // to measure; clicking it would wait for it forever.
      for (let i = 0; i < (await folds.count()); i++)
        if (await folds.nth(i).isVisible()) await folds.nth(i).click();
    }
    // One outline deep (#102): inside a group only a flat subgroup (Fieldset `nested`) or a
    // Choices question, never a second outlined fieldset.
    await expect(
      page.locator('.ui-group fieldset:not(.ui-choices, .nested)'),
      route.path
    ).toHaveCount(0);
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
          // Every admin route in turn, axe on each at 100 %: 15 s in CI, up to 29 s on a busy
          // machine, past the default 30 s once. The budget has to scale with the walk.
          // Rejected: splitting per route, which multiplies the logins and the login limit.
          test.slow();
          await login(page, ADMIN_ROUTES[0]!.path, undefined, { 'accept-language': locale });
          for (const route of ADMIN_ROUTES) {
            expect((await page.goto(route.path))?.status(), route.path).toBe(200);
            await measure(page, route, text);
          }
        });
    });

  // The sign-out button is one of the menu's lines: its label starts where the links' labels
  // start. A border from the public button rule once pushed it 2px to the right.
  test('the sign-out line aligns with the menu links', async ({ page }) => {
    onlyA11y('measures the layout with a script');
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, ADMIN_ROUTES[0]!.path);
    for (const summary of await page.locator('.admin-account:not([open]) > summary').all())
      await summary.click();
    const [logout, link] = await page.evaluate(() =>
      ['.admin-account-actions .admin-logout', '.admin-account-actions > a'].map((selector) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(selector)!);
        return range.getBoundingClientRect().left;
      })
    );
    expect(logout).toBe(link);
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
    // An image that fails lays out as its alt text: a cover hero once took that text's width as
    // its column and scrolled sideways at 320 CSS px (seen when a worktree lacked the files).
    test('every public route with its images failing, at 200% text', async ({ page }) => {
      onlyA11y('measures the layout with a script');
      await page.route('**/media/**', (route) => route.abort());
      for (const route of PUBLIC_ROUTES) {
        expect((await page.goto(route.path))?.status(), route.path).toBe(200);
        await setTextSize(page, '200%');
        await layoutGate(page, `${route.path} without images at 200%`, route.within);
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
      // The catalogue holds what screens will hold: no script but KeyReveal's copy enhancement, the
      // navigation's and a long Choices list's search.
      await expect(
        page.locator(
          'script:not([src="/_admin/copy.js"], [src="/_admin/nav.js"], [src="/_admin/choices.js"], [src="/_admin/drop-upload.js"])'
        )
      ).toHaveCount(0);
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
        for (const summary of await page.locator('.ui-fold:not(.ui-confirm) > summary').all())
          await summary.click();
        await layoutGate(page, 'catalogue');
        // Each stacking group stands in one column: every button as wide as its group.
        const widths = await page.locator('.ui-actions.stack').evaluateAll((groups) =>
          groups.map(
            (group) =>
              new Set(
                [...group.querySelectorAll('.ui-button')]
                  .map((node) => Math.round(node.getBoundingClientRect().width))
                  // A button in a closed confirmation is not laid out (as in layoutGate).
                  .filter((width) => width > 0)
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

  // The menu's rail (#87): from 60rem a button collapses it to icons, the browser remembers it,
  // each icon keeps its label as its name and shows it on focus; without JavaScript there is no
  // button and the menu stays whole.
  test('the menu collapses to a rail of icons and remembers it', async ({ page }) => {
    onlyA11y('the collapse button is the script itself');
    await open(page);
    const sidebar = page.locator('.admin-sidebar');
    const media = sidebar.getByRole('link', { name: 'Media' });
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
    expect((await sidebar.boundingBox())!.width).toBeLessThan(80);
    await expect(media).toBeVisible();
    const iconOffsets = await sidebar.evaluate((side) => {
      const box = side.getBoundingClientRect();
      return [
        ...side.querySelectorAll(
          '.ui-navgroup > ul > li > a > svg, .ui-navgroup summary > svg:first-child, .admin-account > summary > svg:first-child, .admin-collapse svg'
        ),
      ]
        .map((icon) => icon.getBoundingClientRect())
        .filter((icon) => icon.width && icon.height)
        .map((icon) => Math.abs(icon.left + icon.width / 2 - (box.left + box.width / 2)));
    });
    expect(iconOffsets.length).toBeGreaterThan(5);
    expect(Math.max(...iconOffsets)).toBeLessThanOrEqual(1);
    for (const children of await sidebar.locator('.ui-navgroup-sub').all())
      await expect(children).toBeHidden();
    await media.hover();
    expect((await media.locator('span').boundingBox())!.width).toBeGreaterThan(20);
    await page.locator('main .ui-navgroup-disclosure:not([open]) > summary').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
    await page.getByRole('button', { name: 'Expand menu' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'full');
    expect((await media.locator('span').boundingBox())!.width).toBeGreaterThan(20);
    await layoutGate(page, 'expanded menu', '.admin-sidebar');
    if (isA11y()) await expectNoAxeViolations(page);
  });

  test('without JavaScript the menu has no collapse button and stays whole', async ({ page }) => {
    test.skip(isA11y(), 'the no-js project proves the menu without its script');
    await open(page);
    await expect(page.locator('[data-nav-toggle]')).toBeHidden();
    await expect(page.locator('.admin-sidebar').getByRole('link', { name: 'Media' })).toBeVisible();
  });

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
      await expect(page.locator('script:not([src="/_admin/nav.js"])')).toHaveCount(0);
      await expectNoAxeViolations(page, { dark: true });
    });

  // The edit screen's actions in every window (#160): the bar stays where it is one or two lines,
  // the dock takes Save and the main action where it scrolls away, and neither is kept where it
  // would cost too much of the window.
  test('the editor keeps its actions in reach without covering the document', async ({ page }) => {
    await login(page, '/admin/probe/content/new?type=article');
    await page
      .locator('[name="title.nl"]')
      .fill(`Actiebalk ${test.info().project.name} ${crypto.randomUUID()}`);
    await page.getByRole('button', { name: /^(Concept maken|Create draft)$/ }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    // As long as a real article, without a dozen blocks to make first.
    await page
      .locator('.ui-edit-main')
      .evaluate((main: HTMLElement) => (main.style.minBlockSize = '4000px'));
    const bar = page.locator('.ui-item-bar');
    const dock = page.locator('.ui-item-bar-dock');
    const save = bar.getByRole('button', { name: /^(Opslaan|Save)$/ });
    const measure = () =>
      page.evaluate(() => {
        const box = document.querySelector('.ui-item-bar-dock')!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height, window: innerHeight };
      });
    const scrollDown = async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    };

    for (const size of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 720, height: 450 },
      { width: 800, height: 500 },
    ]) {
      await page.setViewportSize(size);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(bar).toHaveCSS('position', 'static');
      await expect(dock).toHaveCSS('position', 'fixed');
      // Scroll and measure as one retried step: hydration shrinks the page and then grows the side
      // column by 65 px, so a scroll to the end made before it no longer is the end. Rejected:
      // waiting for hydration first, as no signal says when the last enhancement has run.
      await expect(async () => {
        await scrollDown();
        const box = await measure();
        expect(box.bottom, `dock at the window's edge at ${size.width}`).toBe(box.window);
        expect(box.height / box.window, `dock cost at ${size.width}`).toBeLessThan(0.2);
        await expect(save).toBeInViewport({ timeout: 1000 });
        // The end of the document can be read above the dock.
        const end = await page.locator('.ui-edit-side').evaluate((e) => e.getBoundingClientRect());
        expect(end.bottom, `end of the document at ${size.width}`).toBeLessThanOrEqual(box.top);
      }).toPass({ timeout: 15_000 });
      await layoutGate(page, `editor dock at ${size.width}`, '.ui-item-bar');
      await expectNoAxeViolations(page);
    }

    // No tab stop disappears behind the dock.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await focusObscuredProblems(page, '.ui-edit-page')).toEqual([]);

    for (const size of [
      { width: 1280, height: 720 },
      { width: 1280, height: 500 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(size);
      await expect(dock).toHaveCSS('display', 'contents');
      await expect(bar).toHaveCSS('position', 'sticky');
      await scrollDown();
      await expect(save).toBeInViewport();
    }

    // Where one line no longer fits or costs too much, both scroll with the page.
    for (const size of [
      { width: 320, height: 256 },
      { width: 300, height: 568 },
    ]) {
      await page.setViewportSize(size);
      await expect(dock).toHaveCSS('display', 'contents');
      await expect(bar).toHaveCSS('position', 'static');
    }

    // Labels whole at 320 CSS px and 200% text, where the line may wrap but stays in one piece.
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'editor dock at 200% text', '.ui-item-bar');
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
// § B). scripts/e2e/e2e.mjs publishes one page per example of `BLOCK_DEFINITIONS`, slug
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
        // Only the enhancement modules of lib/project.ts.
        expect(await page.locator(OTHER_SCRIPTS).count()).toBe(0);
        // The header is the title and, without a hero image, its closing line (#105).
        const rendered = await page.locator('main > :not(h1, hr.page-rule)').count();
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

// The tenant shell is one navigation surface across routes, locales and site memberships.
// A second, empty site catches stale site names and links when changing tenants.
test.describe('admin-shell', () => {
  const email = 'shell-admin@probe.test';
  const other = 'shell-other';
  // A live API key whose name has no break opportunity, long enough to overflow with any font. Its
  // revoke button once repeated the name and was clipped (TODO #63); the whole overview is now
  // measured at 320 CSS px and 200% text on every run and platform, that button included.
  const unbroken = 'newsletter_sync_production_e2e_a11y_1761600000000';

  /** Runs one use case as the system on tenant probe, outside the browser. */
  async function onProbe<T>(run: (invoker: Invoker, tenantId: string) => Promise<T>): Promise<T> {
    const probe = await tenantId();
    return withInvoker((invoker) => run(invoker, probe));
  }

  test.beforeAll(async () => {
    const probe = await tenantId();
    const tenant = await asOwner((owner) =>
      // Fixed slug, reused on a database that outlives the run: the test clicks it by name.
      testTenant(owner, other, {
        name: 'Second editorial site',
        locales: ['en', 'nl'],
        platformDomain: process.env['PLATFORM_DOMAIN']!,
        reuse: true,
      })
    );
    await withInvoker(async (invoker) => {
      for (const site of [probe, tenant.id]) {
        try {
          await invoker.run(useCases.inviteMember, systemPrincipal(site, 'e2e'), {
            email,
            capabilities: ['tenant:admin'],
          });
        } catch (e) {
          if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
        }
      }
    });
  });

  test('navigation groups open and close without navigating, including without scripts', async ({
    page,
  }) => {
    await login(page, '/admin/probe/content?type=page', email);
    await expect(page.locator('.admin-sidebar-top [data-nav-toggle]')).toHaveCount(1);
    await expect(page.locator('.admin-sidebar-bottom')).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Site navigation' });
    const manage = nav
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: /^Manage$/ }) });
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeHidden();
    const summary = manage.locator(':scope > summary');
    await summary.click();
    await expect(manage).toHaveAttribute('open');
    await expect(page).toHaveURL(/\/content\?type=page$/);
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeVisible();
    await summary.click();
    await expect(manage).not.toHaveAttribute('open');
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(manage).toHaveAttribute('open');
    await page.keyboard.press('Space');
    await expect(manage).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    if (isA11y()) {
      await page.locator('[data-nav-toggle]').click();
      await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
      await page.screenshot({ path: '../../.scratch/sidebar-rail.png' });
      await summary.click();
      await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'full');
      await expect(manage).toHaveAttribute('open');
      await page.locator('[data-nav-toggle]').click();
      await page.locator('.admin-account > summary').click();
      await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'full');
      await expect(page.locator('.admin-account')).toHaveAttribute('open');
      await expect(page.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
      await expectNoAxeViolations(page);
    }
    await nav.getByRole('link', { name: 'Team', exact: true }).click();
    await expect(page).toHaveURL(/\/leden$/);
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(manage).toHaveAttribute('open');
    await manage.locator(':scope > summary').click();
    await expect(manage).not.toHaveAttribute('open');
  });

  /** At 320 CSS px the navigation is one ☰ bar, closed on every page load (#66 PR 1). */
  async function openMenu(page: Page) {
    const summary = page.locator('.admin-menu > summary');
    if ((await summary.isVisible()) && (await page.locator('.admin-menu[open]').count()) === 0)
      await summary.click();
  }

  async function checkShell(page: Page, name: string, current: string) {
    await openMenu(page);
    await expect(page.locator('.admin-site-name')).toHaveText(name);
    await expect(
      page
        .getByRole('navigation', { name: /sitenavigatie|site navigation/i })
        .getByRole('link', { name: current })
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main')).toHaveCount(1);
    if (isA11y()) await expectNoAxeViolations(page);
    else {
      const all = await page
        .locator('script')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ src: node.getAttribute('src'), type: node.getAttribute('type') }))
        );
      // The content editor's live preview, the media pickers' search and upload, a button's
      // target search and the media upload's thumbnails are optional modules, inert in this
      // project; the native flows (the media list, the target select) remain the no-JS
      // contract. Other shell routes still emit no script. The pickers load once per field, so
      // an editor with two buttons carries the target search twice.
      const path = new URL(page.url()).pathname;
      const EDITOR_MODULES = ['/_admin/media-picker.js', '/_admin/target-picker.js'];
      const picker = (s: { src: string | null }) => EDITOR_MODULES.includes(s.src ?? '');
      // Every tenant route carries the menu's collapse script (#87), a classic one in <head>.
      expect(all).toContainEqual({ src: '/_admin/nav.js', type: null });
      // Only the integrated editor hydrates. Its tabs and live preview start after hydration;
      // no-JavaScript still receives the complete native form and one inert bootstrap.
      const editor = /\/content\/[0-9a-f-]{36}$/.test(path);
      const bootstrap = all.filter((s) => s.src === null);
      expect(bootstrap).toHaveLength(editor ? 1 : 0);
      const scripts = all.filter((s) => !picker(s) && s.src !== '/_admin/nav.js' && s.src !== null);
      if (all.some(picker)) {
        expect(editor).toBe(true);
        expect(all.filter(picker).every((s) => s.type === 'module')).toBe(true);
      }
      expect(scripts).toEqual(
        /\/media$/.test(path)
          ? [
              { src: '/_admin/file-preview.js', type: 'module' },
              { src: '/_admin/drop-upload.js', type: 'module' },
              { src: '/_admin/content-bulk.js', type: 'module' },
            ]
          : /\/content$/.test(path) && (await page.locator('#content-bulk').count())
            ? [{ src: '/_admin/content-bulk.js', type: 'module' }]
            : []
      );
    }
  }

  test('site navigation persists through content, editor, media, settings and a second tenant', async ({
    page,
  }) => {
    await login(page, '/admin/probe', email);
    await checkShell(page, 'Probe', 'Dashboard');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await checkShell(page, 'Probe', 'Pages');
    await expect(page.locator('#content-table tbody tr').first()).toBeVisible();
    await page.locator('#content-table tbody th a').first().click();
    await checkShell(page, 'Probe', 'Pages');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Media' })
      .click();
    await checkShell(page, 'Probe', 'Media');
    await page
      .locator('.ui-navgroup-disclosure > summary')
      .filter({ hasText: /^Settings$/ })
      .click();
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Settings', exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/probe\/site$/);
    // The subjects of Settings sit under it in the sidebar (#81-rest), not as tabs on the page;
    // since #114 the look only, API access, assistance and usage are under Manage.
    const sections = page
      .locator('.ui-navgroup-disclosure')
      .filter({ has: page.locator('summary', { hasText: /^Settings$/ }) })
      .locator('.ui-navgroup-sub');
    await expect(sections.getByRole('link')).toHaveText([
      'Settings',
      'General',
      'Theme',
      'Logo and wordmark',
      'Menus and footer',
    ]);
    await expect(sections.getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(page.getByRole('main').locator('.ui-subnav')).toHaveCount(0);
    await sections.getByRole('link', { name: 'Theme' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/site\?section=theme$/);
    await expect(sections.getByRole('link', { name: 'Theme' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await page.locator('.admin-account > summary').click();
    await page.getByRole('link', { name: 'Back to your sites' }).click();
    await page.getByRole('main').getByRole('link', { name: 'Second editorial site' }).click();
    await checkShell(page, 'Second editorial site', 'Dashboard');
    // That layout was mounted on a hydrated page: its script runs, and only once.
    if (isA11y()) {
      await page.locator('[data-nav-toggle]').click();
      await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
      await page.locator('[data-nav-toggle]').click();
      await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'full');
    }
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await expect(page.locator('#content-table tbody tr')).toHaveCount(0);
    await checkShell(page, 'Second editorial site', 'Pages');
    // An empty list offers the next step once, where the reader is looking.
    await expect(page.getByRole('heading', { name: 'No pages yet.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New page' })).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('Probe');
  });

  // #66 PR 1: the dashboard first, then three groups with short labels and icons; an article is
  // marked as an article in its list, its editor and its writer. Axe in both schemes.
  test('the dashboard has six widgets and the navigation three groups', async ({ page }) => {
    await login(page, '/admin/probe', email);
    await checkShell(page, 'Probe', 'Dashboard');
    await expect(page.locator('.admin-menu > summary')).toBeHidden();
    await expect(page.locator('.ui-dashboard > .ui-widget')).toHaveCount(6);
    await expect(page.locator('.ui-widget.empty')).toHaveCount(2);
    // Two columns on a wide screen, never three (brief edit-screen § 4).
    expect(
      await page
        .locator('.ui-dashboard > .ui-widget')
        .evaluateAll(
          (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().left))).size
        )
    ).toBe(2);
    await expect(page.getByRole('region', { name: 'Usage and limits' })).toContainText(
      'Supporters'
    );
    await expect(
      page.getByRole('region', { name: 'Recently edited' }).getByRole('listitem')
    ).toHaveCount(5);
    // Filled from the notifications: the newest few and a link to all of them.
    await expect(
      page
        .getByRole('region', { name: 'Waiting for you' })
        .getByRole('link', { name: /^All notifications \(\d+\)$/ })
    ).toHaveAttribute('href', '/admin/probe/meldingen');
    const nav = page.getByRole('navigation', { name: 'Site navigation' });
    for (const [group, links] of [
      ['Content', ['Pages', 'Articles', 'People']],
      ['Library', ['Media']],
    ] as const)
      await expect(nav.getByRole('list', { name: group }).getByRole('link')).toHaveText([...links]);
    // #114 (Jaap 2026-10-31): Manage apart from Settings, Team its own line under Manage, the
    // screens you set once (domains, status, export) within its native disclosure.
    await expect(nav.locator('.ui-navgroup:last-child summary')).toHaveText(['Manage', 'Settings']);
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeHidden();
    await nav
      .locator('summary')
      .filter({ hasText: /^Manage$/ })
      .click();
    await nav.getByRole('link', { name: 'Manage' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Manage' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Manage' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Team', exact: true })).toBeVisible();
    await expect(nav.locator('summary').filter({ hasText: /^Settings$/ })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link')).toHaveText([
      'Probe',
      'Team',
      'Domains',
      'Connections',
      'API access',
      'AI assistance',
      'Usage and limits',
      'Status',
      'Log',
      'Export',
    ]);
    await page.getByRole('main').getByRole('link', { name: 'Domains' }).click();
    await expect(nav.getByRole('link', { name: 'Domains' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Manage' })).toHaveAttribute('aria-current', 'true');
    if (isA11y()) await expectNoAxeViolations(page, { dark: true });
    await page.goto('/admin/probe');
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveCount(0);
    await expect(page.locator('.admin-site-name')).toHaveAttribute('href', '/admin/probe');
    if (isA11y()) await expectNoAxeViolations(page, { dark: true });

    await nav.getByRole('link', { name: 'Articles' }).click();
    await checkShell(page, 'Probe', 'Articles');
    if (isA11y()) await expectNoAxeViolations(page, { dark: true });
    // The article editor loads no live preview, unlike the page editor checkShell expects, so
    // its mark is checked here directly.
    await page.locator('#content-table tbody th a').first().click();
    await expect(nav.getByRole('link', { name: 'Articles' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(page.locator('#item-edit')).toBeVisible();
    await page.goto(`${new URL(page.url()).pathname}/write`);
    await expect(nav.getByRole('link', { name: 'Articles' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Pages' })).not.toHaveAttribute('aria-current');
  });

  // #114: a member without an administrator's capabilities sees no Manage and no empty group,
  // and the Manage page refuses them rather than listing nothing.
  test('an author sees no Manage, and the Manage page refuses them', async ({ page }) => {
    const author = 'shell-author@probe.test';
    await withInvoker(async (invoker) => {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'e2e'), {
          email: author,
          capabilities: capabilitiesFor('author'),
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    });
    await login(page, '/admin/probe', author);
    const nav = page.getByRole('navigation', { name: 'Site navigation' });
    await expect(nav.getByRole('link', { name: 'Pages' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Manage' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Team' })).toHaveCount(0);
    expect(
      await nav
        .locator('.ui-navgroup')
        .evaluateAll((groups) => groups.filter((g) => !g.querySelector('a')).length)
    ).toBe(0);
    const refused = await page.goto('/admin/probe/beheer');
    expect(refused?.status()).toBe(403);
  });

  // MY-110 C3: an author edits a page with a form but has no `forms:read`. The screen opens, says
  // the form is linked and keeps the reference, rather than failing or calling it missing.
  test('an author opens a page with a form and sees that it is linked', async ({
    page,
    request,
  }) => {
    requireApi();
    const author = 'form-author@probe.test';
    await withInvoker(async (invoker) => {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'e2e'), {
          email: author,
          capabilities: capabilitiesFor('author'),
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    });
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'page',
      slug: `e2e-blokken-${test.info().project.name}`,
    });
    await login(page, `/admin/probe/content/${items[0]!.id}`, author);
    const rests = page.locator('[data-block-rest] .ui-block-text-form');
    await expect(rests).toHaveCount(2);
    await expect(rests.first().locator('.ui-block-text-kind')).toContainText(
      /Linked form|Gekoppeld/
    );
    await expect(rests.locator('[data-missing]')).toHaveCount(0);
    await expect(rests.locator('.ui-block-text-input')).toHaveCount(0);
  });

  // #66 PR 4 (Jaap 2026-10-30, zoomed out): the workspace stands at one distance from the
  // sidebar and grows with the window, instead of a capped page centred further and further away.
  test('the workspace keeps its place beside the sidebar and grows on a wide screen', async ({
    page,
  }) => {
    await login(page, '/admin/probe/content?type=page', email);
    // The URL changes before the document has arrived, and the measuring below does not wait (#167).
    await expect(page.locator('.admin-workspace .page.admin')).toBeVisible();
    const measure = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      return page.evaluate(() => {
        const side = document.querySelector('.admin-sidebar')!.getBoundingClientRect();
        const main = document
          .querySelector('.admin-workspace .page.admin')!
          .getBoundingClientRect();
        return { gap: Math.round(main.left - side.right), width: Math.round(main.width) };
      });
    };
    const normal = await measure(1280);
    const wide = await measure(2560);
    expect(wide.gap).toBe(normal.gap);
    expect(wide.width - normal.width).toBe(1280);
  });

  // Trial 4b-8/9 (#113): Team's table is as wide as its content with every cell of a row on one
  // baseline, and the long Theme form keeps its save in view at the bottom of the window.
  test('Team reads as a compact table, and Theme keeps its save in view', async ({ page }) => {
    // Other flows add UUID-length operators to probe. Measure the promised short-list state
    // on its own tenant, rather than letting concurrent fixtures choose the table's width.
    const slug = `compact-team-${test.info().project.name}-${Date.now().toString(36)}`;
    const tenant = await asOwner((owner) =>
      testTenant(owner, slug, { platformDomain: process.env['PLATFORM_DOMAIN']! })
    );
    await withInvoker((invoker) =>
      invoker.run(useCases.inviteMember, systemPrincipal(tenant.id, 'e2e'), {
        email,
        capabilities: capabilitiesFor('admin'),
      })
    );
    await login(page, `/admin/${slug}/leden`, email);
    await page.setViewportSize({ width: 1280, height: 800 });
    const team = await page.locator('#members').evaluate((table) => {
      const row = table.querySelector('tbody tr')!;
      // The bottom of each cell's first line of text: equal when the cells share a baseline.
      const bottoms = [...row.querySelectorAll('th, td')].map((cell) => {
        // No filter callback: with JavaScript off (no-js) the page cannot run one.
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent!.trim()) node = walker.nextNode();
        const range = document.createRange();
        range.selectNodeContents(node!);
        return range.getClientRects()[0]!.bottom;
      });
      return {
        width: table.getBoundingClientRect().width,
        column: table.closest('main')!.getBoundingClientRect().width,
        spread: Math.max(...bottoms) - Math.min(...bottoms),
      };
    });
    expect(team.width).toBeLessThan(team.column * 0.8);
    expect(team.spread).toBeLessThanOrEqual(4);

    await page.goto(`/admin/${slug}/site?section=theme`);
    const save = page.getByRole('button', { name: 'Save theme' });
    await expect(save).toBeInViewport();
  });

  for (const locale of ['nl', 'en']) {
    test.describe(`sidebar language ${locale}`, () => {
      test.use({ locale });
      const layoutEmail = `shell-layout-${locale}@probe.test`;
      test.beforeAll(async () => {
        await withInvoker(async (invoker) => {
          try {
            await invoker.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'e2e'), {
              email: layoutEmail,
              capabilities: ['tenant:admin'],
            });
          } catch (e) {
            if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
          }
        });
        await asOwner((owner) =>
          owner
            .updateTable('operators')
            .set({ ui_locale: locale })
            .where('email', '=', layoutEmail)
            .execute()
        );
      });
      test(`sidebar follows its longest label and reflows in ${locale}`, async ({ page }) => {
        await login(page, '/admin/probe/content?type=page', layoutEmail, {
          'accept-language': locale,
        });
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator('.admin-account > summary').click();
        // The menu's lines and the account lines above it set the column (#114: "Back to your
        // sites" on one line), and every line is one line of text.
        const measure = () =>
          page.locator('.admin-sidebar').evaluate((sidebar) => {
            const links = [
              ...sidebar.querySelectorAll(
                '.ui-navgroup a, .ui-navgroup summary, .admin-account > summary, .admin-account-actions > a, .admin-account-actions button, .admin-collapse'
              ),
            ].filter((link) => link.getClientRects().length);
            // Lines of text per link: the distinct tops of its visible text (icons left out).
            const lines = links.map((link) => {
              const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
              const tops = new Set<number>();
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent!.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects())
                  if (rect.width) tops.add(Math.round(rect.top));
              }
              return tops.size;
            });
            const longest = Math.max(
              ...links.map((link) => {
                const range = document.createRange();
                range.selectNodeContents(link.querySelector('span') ?? link);
                return range.getBoundingClientRect().width;
              })
            );
            const active = sidebar
              .querySelector('.ui-navgroup [aria-current]')!
              .getBoundingClientRect();
            return {
              width: sidebar.getBoundingClientRect().width,
              longest,
              edge: sidebar.getBoundingClientRect().right - active.right,
              wrapped: lines.filter((n) => n > 1).length,
              switchRows: new Set(
                [...sidebar.querySelectorAll('.admin-content-locale button')].map((b) =>
                  Math.round(b.getBoundingClientRect().top)
                )
              ).size,
            };
          });
        const metrics = await measure();
        expect(metrics.width - metrics.longest).toBeLessThan(100);
        expect(metrics.edge).toBeLessThan(2);
        expect(metrics.wrapped).toBe(0);
        expect(metrics.switchRows).toBe(1);
        // Closed children still reserve their intrinsic width: opening either group must not
        // move the workspace. Closing it again keeps the same width and hides its destinations.
        for (const label of locale === 'nl' ? ['Beheer', 'Instellingen'] : ['Manage', 'Settings']) {
          const summary = page
            .locator('.ui-navgroup-disclosure > summary')
            .filter({ hasText: new RegExp(`^${label}$`) });
          await summary.click();
          const open = await measure();
          expect(open.wrapped).toBe(0);
          expect(Math.abs(open.width - metrics.width)).toBeLessThan(1);
          await summary.click();
          await expect(summary.locator('..').getByRole('link').first()).toBeHidden();
          expect(Math.abs((await measure()).width - metrics.width)).toBeLessThan(1);
        }
        if (isA11y()) await expectNoAxeViolations(page);
        await page.screenshot({
          path: `../../.scratch/sidebar-${locale}-wide-${test.info().project.name}.png`,
          fullPage: false,
        });
        await page.goto('/admin/probe/content?type=page');
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await page.locator('.admin-menu > summary').click();
        await page.locator('.admin-account > summary').click();
        for (const summary of await page.locator('.ui-navgroup-disclosure > summary').all())
          await summary.click();
        await layoutGate(page, `sidebar ${locale}`, '.admin-sidebar');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `../../.scratch/sidebar-${locale}-320-200-${test.info().project.name}.png`,
          fullPage: false,
        });
        await page.locator('.ui-navgroup-disclosure > summary').first().scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `../../.scratch/sidebar-${locale}-groups-320-200-${test.info().project.name}.png`,
          fullPage: false,
        });
      });
    });
  }

  test.describe('narrow dashboard', () => {
    test.use({ viewport: NARROW });
    test('stacks the widgets in one column behind a closed ☰ bar', async ({ page }) => {
      await login(page, '/admin/probe', email);
      await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
      await expect(page.getByRole('navigation', { name: 'Site navigation' })).toBeHidden();
      const lefts = await page
        .locator('.ui-dashboard > .ui-widget')
        .evaluateAll(
          (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().left))).size
        );
      expect(lefts).toBe(1);
      await page.locator('.admin-menu > summary').click();
      await checkShell(page, 'Probe', 'Dashboard');
    });
  });

  test.describe('narrow navigation and action labels', () => {
    test.use({ viewport: NARROW });
    test('works with keyboard and at 200% text', async ({ page }) => {
      const { id } = await onProbe((invoker, tenantId) =>
        invoker.run(useCases.createKey, systemPrincipal(tenantId, 'e2e'), {
          name: `${unbroken}_${test.info().project.name}`,
          capabilities: ['content:read'],
        })
      );
      try {
        await narrowOverview(page);
      } finally {
        await onProbe((invoker, tenantId) =>
          invoker.run(useCases.revokeKey, systemPrincipal(tenantId, 'e2e'), { id })
        );
      }
    });
  });

  /** Team, API access and an editor at 320 CSS px and 200% text: reflow, targets, whole labels. */
  async function narrowOverview(page: Page) {
    await login(page, '/admin/probe/leden', email);
    await setTextSize(page, '200%');
    // Closed by default on a phone; the ☰ bar opens and closes it from the keyboard.
    await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
    await expect(page.getByRole('navigation', { name: 'Site navigation' })).toBeHidden();
    const menu = page.getByText('Menu', { exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await layoutGate(page, 'members with the menu open');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await page.locator('#content-table tbody th a').first().click();
    await expect(page.locator('#item-edit')).toBeVisible();
    if (isA11y())
      await expect(page.getByRole('tab', { name: 'Content', exact: true })).toBeVisible();
    await setTextSize(page, '200%');
    await layoutGate(page, 'editor');
    // The long key's revoke button (TODO #63), on API access since #101.
    await page.goto('/admin/probe/site?section=api');
    await setTextSize(page, '200%');
    await layoutGate(page, 'API access with a long key name');
  }

  test.describe('Dutch shell copy', () => {
    test.use({ locale: 'nl-NL', viewport: NARROW });
    test('keeps the active section and whole navigation labels at 200% text', async ({ page }) => {
      await login(page, '/admin/probe', email);
      await setTextSize(page, '200%');
      await checkShell(page, 'Probe', 'Dashboard');
      await layoutGate(page, 'dashboard with the menu open');
      await page
        .getByRole('navigation', { name: 'Sitenavigatie' })
        .getByRole('link', { name: 'Pagina’s' })
        .click();
      await checkShell(page, 'Probe', 'Pagina’s');
    });
  });
});
