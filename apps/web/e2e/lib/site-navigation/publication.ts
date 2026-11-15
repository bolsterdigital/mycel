// The second half of the CMS task of the menu editor (brief site-navigation § 10): choose the same
// menu for the main navigation and a footer column, narrow the bar, see in the preview what each
// language would get and what blocks it, publish one language, find the versions, restore an
// older one as the draft and take the language offline again. The registry is the read-back. In
// the a11y project the overview, the placements form, the preview and a version also pass axe and
// the layout gate at 320 CSS px and 200% text (skill ui-action-layout).
// Rejected: building the menus through the editor again (the editor test does that); they are
// seeded through the API so this test starts where that one ends.
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi, postUseCase } from '../api';
import { tenantId, withInvoker } from '../invoker';
import { login } from '../login';
import { measure } from './editor';

interface Menu {
  id: string;
  name: string;
  nodes: unknown[];
}
interface Navigation {
  revisionId: string | null;
  document: { menus: Menu[]; placements: Record<string, any> };
  publication: { locale: string; revisionId: string }[];
  revisions: { id: string; restoredFrom: string | null }[];
}

const get = (request: APIRequestContext) => callApi<Navigation>(request, 'site.navigation.get', {});

export async function exerciseNavigationPublication(page: Page, request: APIRequestContext) {
  const unique = randomUUID().slice(0, 8);
  const title = `Kopdoel ${unique}`;
  const { item, revision } = await callApi(request, 'content.item.create', {
    slug: `kopdoel-${unique}`,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: title },
      blocks: [],
    },
  });
  const system = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker((invoker) =>
    invoker.run(useCases.publishItem, system, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    })
  );
  // Two menus as the editor would leave them: the page, an address and a group labelled in nl
  // only; and one legal link.
  const [main, legal] = [`kop-${unique}`, `voet-${unique}`];
  const group = `Meer ${unique}`;
  const menus: Menu[] = [
    {
      id: main,
      name: `Kop ${unique}`,
      nodes: [
        { id: `${main}-page`, kind: 'link', target: { kind: 'content', itemId: item.id } },
        {
          id: `${main}-url`,
          kind: 'link',
          label: { nl: 'Elders', en: 'Elsewhere' },
          target: { kind: 'url', href: '/elders' },
        },
        { id: `${main}-group`, kind: 'group', label: { nl: group }, children: [] },
      ],
    },
    {
      id: legal,
      name: `Voet ${unique}`,
      nodes: [
        {
          id: `${legal}-privacy`,
          kind: 'link',
          label: { nl: 'Privacy', en: 'Privacy' },
          target: { kind: 'url', href: '/privacy' },
        },
      ],
    },
  ];
  const before = await get(request);
  await callApi(request, 'site.navigation.update', {
    baseRevisionId: before.revisionId,
    document: { ...before.document, menus: [...before.document.menus, ...menus] },
  });
  const done = /\/navigation\?(saved|merged)=1$/;

  // One menu in the main navigation and in the first footer column, another in the legal links.
  await login(page, '/admin/probe/navigation/placements', undefined, { 'accept-language': 'en' });
  await page.locator('#placement-main').selectOption({ label: `Kop ${unique}` });
  await page.locator('#placement-footer-0').selectOption({ label: `Kop ${unique}` });
  await page.locator('#placement-footer-0-title').fill('Over ons');
  await page.locator('#placement-legal').selectOption({ label: `Voet ${unique}` });
  await page.getByRole('button', { name: 'Save placements' }).click();
  await expect(page).toHaveURL(done);
  const placements = page.locator('#navigation-placements');
  await expect(placements).toContainText(`Kop ${unique}`);
  await expect(placements).toContainText(`Voet ${unique}`);
  await measure(page, 'navigation-overview');
  await page.getByRole('link', { name: `Kop ${unique}` }).click();
  await expect(page.locator('main')).toContainText('Used in: Main navigation, Footer');
  const wide = (await get(request)).revisionId!;

  // A new main menu stands in the bar whole; the bar is then narrowed item by item.
  await page.goto('/admin/probe/navigation/placements');
  await expect(page.getByRole('checkbox', { name: group })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Elders' }).uncheck();
  await measure(page, 'navigation-placements');
  await page.getByRole('button', { name: 'Save placements' }).click();
  await expect(page).toHaveURL(done);
  const narrowed = await get(request);
  expect(narrowed.document.placements['main']).toEqual({
    menuId: main,
    bar: [`${main}-page`, `${main}-group`],
  });
  expect(narrowed.document.placements['footer'][0]).toEqual({
    menuId: main,
    title: { nl: 'Over ons' },
  });

  // In en the page is not published and the group has no text: the preview says what is left
  // out and that the group blocks publishing, and offers no publish button.
  await page.goto('/admin/probe/navigation/preview/en');
  const problems = page.locator('#navigation-problems');
  await expect(problems).toContainText('Blocks publication');
  await expect(problems).toContainText('not published publicly in en');
  await expect(page.getByRole('button', { name: 'Publish in en' })).toHaveCount(0);

  // In nl nothing blocks: the preview shows the bar and the footer column, and publishes. The
  // group without sub-items shows nothing (ADR 036 rule 8).
  const elders = (within: string) =>
    page.locator(`${within} .ui-menu-item`).filter({ hasText: 'Elders' });
  await page.goto('/admin/probe/navigation/preview/nl');
  await expect(page.locator('#preview-main')).toContainText(title);
  await expect(page.locator('#preview-main')).toContainText('In the bar');
  await expect(elders('#preview-main')).not.toContainText('In the bar');
  await expect(page.locator('#preview-main')).not.toContainText(group);
  await expect(page.locator('#preview-footer')).toContainText('Over ons');
  await expect(page.locator('#preview-footer')).not.toContainText('In the bar');
  await expect(page.locator('#preview-legal')).toContainText('Leads to /privacy');
  await measure(page, 'navigation-preview');
  await page.getByRole('button', { name: 'Publish in nl' }).click();
  await expect(page).toHaveURL(/\/preview\/nl\?published=1$/);
  await expect(page.getByRole('status')).toContainText('Published in nl.');
  expect((await get(request)).publication.map((p) => p.locale)).toContain('nl');

  // The versions list the wide bar; restoring it makes a new draft and publishes nothing.
  await page.goto('/admin/probe/navigation/revisions');
  await page.locator(`a[href$="/revisions/${wide}"]`).click();
  await expect(elders('#version-main')).toContainText('In the bar');
  await measure(page, 'navigation-version');
  await page.locator('#navigation-restore summary').click();
  await page.getByRole('button', { name: 'Yes, restore' }).click();
  await expect(page).toHaveURL(/\/navigation\?restored=1$/);
  const restored = await get(request);
  // Another test may save right after the restore, so the restore need not be the newest.
  expect(restored.revisions.some((r) => r.restoredFrom === wide)).toBe(true);
  expect(restored.publication.find((p) => p.locale === 'nl')?.revisionId).not.toBe(
    restored.revisionId
  );
  await expect(page.locator('#navigation-locales')).toContainText('Has changes');

  // Offline again in nl, behind a confirmation.
  await page.goto('/admin/probe/navigation/preview/nl');
  await page.locator('#navigation-publish summary').click();
  await page.getByRole('button', { name: 'Yes, take offline' }).click();
  await expect(page).toHaveURL(/\/preview\/nl\?offline=1$/);
  expect((await get(request)).publication.map((p) => p.locale)).not.toContain('nl');

  // Leave the site as it was: these placements and menus go. The other project may have
  // published a revision that places them meanwhile; then they stay until its own cleanup.
  const last = await get(request);
  const mine = (p: { menuId: string } | null) => (p && [main, legal].includes(p.menuId) ? null : p);
  const { placements: was } = last.document;
  await postUseCase(request, 'site.navigation.update', {
    baseRevisionId: last.revisionId,
    document: {
      menus: last.document.menus.filter((m) => m.id !== main && m.id !== legal),
      placements: {
        main: mine(was['main']),
        actions: mine(was['actions']),
        footer: was['footer'].filter((f: { menuId: string }) => mine(f)),
        legal: mine(was['legal']),
      },
    },
  });
}
