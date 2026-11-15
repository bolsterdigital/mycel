// The anchor task (ADR 036 rule 3): an editor points a menu item at one block of a
// published page with the item form's plain select, and a visitor who follows the item from
// another page lands on that block, below the top of the viewport but not under it. With
// JavaScript the same link from the page itself closes the menu dialog before the jump, and the
// dialog's scroll lock keeps the room of a classic scrollbar, so the page does not shift.
// In the a11y project the item form with the choice passes axe and the layout gate at 320 CSS px
// and 200% text (`measure`).
// Rejected: a test in public-site.spec.ts or admin.spec.ts, both near their size limit.
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expect, type BrowserType, type Page } from '@playwright/test';
import { asOwner, withInvoker } from '../invoker';
import { login } from '../login';
import { isA11y } from '../project';
import { measure } from './editor';
import { publishMenus } from './seed';

export const ANCHOR_LINK = 'Naar het doel';
const TARGET = 'Het doel';

/** A site with a home page, a long page whose block `doel` sits far down, and a menu to it. */
export async function seedAnchors(slug: string) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Anchor fixture',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const editor = `site-editor-${slug}@probe.test`;
  const principal = systemPrincipal(tenant.id, 'e2e');
  await withInvoker(async (invoker) => {
    await invoker.run(useCases.inviteMember, principal, {
      email: editor,
      capabilities: ['content:read', 'content:write'],
    });
    const heading = (id: string, nl: string) => ({
      id,
      type: 'heading' as const,
      version: 1 as const,
      props: { text: { nl } },
    });
    const ids: string[] = [];
    for (const [slugOf, title, blocks] of [
      ['home', 'Welkom', []],
      [
        'lang',
        'Lang',
        [
          ...Array.from({ length: 24 }, (_, i) => heading(`kop-${i}`, `Kop ${i}`)),
          heading('doel', TARGET),
          ...Array.from({ length: 24 }, (_, i) => heading(`na-${i}`, `Daarna ${i}`)),
        ],
      ],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: slugOf,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          blocks: [...blocks],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      ids.push(item.id);
    }
    await publishMenus(
      invoker,
      principal,
      { main: [{ itemId: ids[1]!, label: { nl: ANCHOR_LINK } }] },
      ['nl']
    );
  });
  return { tenantId: tenant.id, editor };
}

/** The editor chooses the block in the item form; the system publishes what was saved. */
export async function chooseAnchor(page: Page, slug: string, tenantId: string, editor: string) {
  await login(page, `/admin/${slug}/navigation/main/items/main-1`, editor);
  const where = page.getByLabel('Where on the page');
  await expect(where.locator('option:checked')).toHaveText('At the top');
  await where.selectOption({ label: `Heading: ${TARGET}` });
  await measure(page, 'menu item with an anchor');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/${slug}/navigation/main\\?saved=1$`));
  const principal = systemPrincipal(tenantId, 'e2e');
  await withInvoker(async (invoker) => {
    const { revisionId, document } = await invoker.run(useCases.getNavigation, principal, {});
    expect(document.menus[0]!.nodes[0]).toMatchObject({ target: { anchor: 'doel' } });
    await invoker.run(useCases.publishNavigation, principal, {
      revisionId: revisionId!,
      locale: 'nl',
    });
  });
  await page.context().clearCookies();
}

/** Opens Menu: the native panel without JavaScript, the dialog with it. */
async function openMenu(page: Page) {
  await page.getByRole('banner').locator('summary', { hasText: 'Menu' }).click();
  if (isA11y()) await expect(page.locator('dialog.site-dialog')).toHaveJSProperty('open', true);
}

/** The block is in view, at its scroll margin below the top, its heading readable. */
async function landed(page: Page) {
  const target = page.locator('#block-doel');
  await expect(target).toHaveText(TARGET);
  await expect(target).toBeInViewport();
  const top = await target.evaluate((e) => e.getBoundingClientRect().top);
  expect(top, 'the scroll margin keeps the block off the edge').toBeGreaterThan(8);
  expect(top).toBeLessThan(80);
}

export async function followAnchor(page: Page, slug: string) {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`/${slug}/home`);
  await openMenu(page);
  await page.getByRole('link', { name: ANCHOR_LINK }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/lang#block-doel$`));
  await landed(page);
  if (!isA11y()) return;

  // From the page itself the link only scrolls: the dialog must close, or the jump is behind it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await openMenu(page);
  await page.getByRole('link', { name: ANCHOR_LINK }).click();
  await expect(page.locator('dialog.site-dialog')).toHaveJSProperty('open', false);
  await landed(page);
}

/**
 * With a classic scrollbar the page keeps its width when the dialog locks scrolling; on a page
 * too short to scroll it gains no gutter either. Headless Chromium hides scrollbars
 * (`--hide-scrollbars`), so this check launches a browser of its own without that flag; the
 * styled scrollbar keeps it classic where the system would overlay it.
 */
export async function scrollLockKeepsWidth(
  browserType: BrowserType,
  baseURL: string,
  headers: Record<string, string>,
  slug: string
) {
  const browser = await browserType.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: headers,
      viewport: { width: 1024, height: 720 },
    });
    const page = await context.newPage();
    for (const path of ['lang', 'home']) {
      await page.goto(`/${slug}/${path}`);
      const scrolls = await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(
          '::-webkit-scrollbar { width: 16px } ::-webkit-scrollbar-thumb { background: gray }'
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        const root = document.documentElement;
        return root.scrollHeight > root.clientHeight;
      });
      // The width the page lays out in. Not the root's `clientWidth`, which with the scroll lock
      // reports the whole viewport whether or not the gutter is kept.
      const width = () => page.evaluate(() => document.body.getBoundingClientRect().width);
      const before = await width();
      if (scrolls)
        expect(
          await page.evaluate(() => window.innerWidth),
          'the harness has a classic scrollbar'
        ).toBeGreaterThan(before);
      await openMenu(page);
      expect(await width(), `${path}: the page keeps its width behind the dialog`).toBe(before);
      await page.keyboard.press('Escape');
    }
  } finally {
    await browser.close();
  }
}
