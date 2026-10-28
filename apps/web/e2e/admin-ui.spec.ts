// The admin component catalogue (brief #56 PR 1 and 2) is the UI gate of lib/admin/ui: every
// component and every page pattern with the longest real labels, measured at 320 CSS px and 200%
// text in both admin locales (skill ui-action-layout), axe in the light and the dark scheme, and
// the dialog opened and closed without JavaScript. Only `tenant:admin` sees it. A screen built from these components inherits the measurements; its own
// spec still checks its own content.
import AxeBuilder from '@axe-core/playwright';
import { Invoker, UseCaseError, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { expect, test, type Page } from '@playwright/test';

const email = 'ui-catalogue@probe.test';
const editor = 'ui-catalogue-editor@probe.test';
const PATTERNS = ['overview', 'detail', 'edit', 'settings', 'form', 'states'] as const;

test.beforeAll(async () => {
  const owner = createDb(process.env['DATABASE_URL']!);
  const app = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(owner).findBySlug('probe');
    if (!probe) throw new Error('probe tenant missing');
    const invoker = new Invoker(
      buildRegistry(),
      createUnitOfWork(app, {
        clock: { now: () => new Date() },
        ids: uuidv7Ids,
        signer: new FakeSigner(),
        inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
        dns: new FakeDns(),
        platform: memoryPlatform,
      })
    );
    for (const [who, capabilities] of [
      [email, ['tenant:admin']],
      [editor, ['media:read']],
    ] as const)
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(probe.id, 'e2e'), {
          email: who,
          capabilities: [...capabilities],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
  } finally {
    await app.destroy();
    await owner.destroy();
  }
});

async function open(page: Page, path = '/admin/probe/_ui', as = email) {
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `2001:db8:56::${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(as);
  const [landed] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === path),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  return landed;
}

/** Elements that reach past the viewport, innermost first; empty when nothing scrolls sideways. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width) return [];
    const past = [...document.body.querySelectorAll('*')]
      .filter((node) => !node.closest('.ui-table-scroll'))
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { node, right: Math.max(box.right, box.left + node.scrollWidth) };
      })
      .filter(({ right }) => right > width + 1);
    return past
      .filter(({ node }) => !past.some((other) => other.node !== node && node.contains(other.node)))
      .slice(0, 5)
      .map(
        ({ node, right }) =>
          `overflow: ${node.tagName.toLowerCase()}.${[...node.classList].join('.')} right=${Math.round(right)} text=${JSON.stringify((node.textContent ?? '').trim().slice(0, 60))}`
      );
  });
}

/** Targets under 44 CSS px and labels that do not fit their own control. */
async function targets(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.ui-button, .ui-subnav a, .ui-view-switch a, .ui-breadcrumb a, .ui-table th a, .ui-fold > summary, .ui-choice'
      ),
    ]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false; // inside a closed dialog
        return box.width < 44 || box.height < 44 || node.scrollWidth > node.clientWidth + 1;
      })
      .map((node) => `small or clipped: ${(node.textContent ?? '').trim()}`)
  );
}

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
    page.getByRole('navigation', { name: 'Sub-navigation' }).getByRole('link', { name: 'General' })
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
  if (test.info().project.name !== 'a11y') {
    // The catalogue holds what screens will hold: no script at all.
    await expect(page.locator('script')).toHaveCount(0);
    return;
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: test.info().outputPath(`catalogue-${colorScheme}.png`),
      fullPage: true,
    });
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations.map((v) => `${colorScheme}: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
  }
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
    test.use({ locale, viewport: { width: 320, height: 900 } });
    test('keeps every label whole and nothing scrolls sideways', async ({ page }) => {
      await open(page);
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      await page.locator('.ui-fold > summary').click();
      expect([...(await overflow(page)), ...(await targets(page))]).toEqual([]);
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
      await page.screenshot({
        path: test.info().outputPath(`catalogue-320-200-${locale}.png`),
        fullPage: true,
      });
      const trigger = page.locator('[command="show-modal"]');
      await trigger.click();
      expect(await overflow(page)).toEqual([]);
    });
  });
}

test('is refused to a member without tenant:admin, patterns included', async ({ page }) => {
  const landed = await open(page, '/admin/probe/_ui', editor);
  expect(landed.status()).toBe(403);
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
    if (test.info().project.name !== 'a11y') return;
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: test.info().outputPath(`pattern-${pattern}-${colorScheme}.png`),
        fullPage: true,
      });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(violations.map((v) => `${colorScheme}: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
    }
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

for (const locale of ['en-GB', 'nl-NL']) {
  test.describe(`page patterns at 320 CSS px and 200% text, ${locale}`, () => {
    test.use({ locale, viewport: { width: 320, height: 900 } });
    test('keep every label whole and nothing scrolls sideways', async ({ page }) => {
      await open(page, `/admin/probe/_ui/${PATTERNS[0]}`);
      for (const pattern of PATTERNS) {
        for (const query of pattern === 'overview' ? ['', '?view=list'] : ['']) {
          await page.goto(`/admin/probe/_ui/${pattern}${query}`);
          await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
          const folds = page.locator('.ui-fold > summary');
          for (let i = 0; i < (await folds.count()); i++) await folds.nth(i).click();
          expect([...(await overflow(page)), ...(await targets(page))], pattern).toEqual([]);
          await page.screenshot({
            path: test.info().outputPath(`pattern-${pattern}${query ? '-list' : ''}-320-200.png`),
            fullPage: true,
          });
        }
      }
    });
  });
}
