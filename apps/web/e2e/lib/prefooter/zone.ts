// The pre-footer zone: a page with the profile `zone`, placed by the navigation and shown between
// the content and the footer of every page that does not switch it off. The editor makes a zone
// under Zones and offers it under Placements; the public side runs on a tenant of its own, so a
// zone placed here never reaches the pages other tests read. Core and database suites cover the
// placement refusals, the trash and what leaves the zone out of search, sitemap and overviews.
// Rejected: a spec of its own (the e2e budget) and placing a zone on `probe`, which would change
// the footer, the ETag and the axe surface of every other public test.
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { systemPrincipal, useCases, type Invoker, type Principal } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { asOwner, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

const text = (nl: string, en: string) => ({ nl, en });

async function seed() {
  const slug = `zone-${randomBytes(4).toString('hex')}`;
  const { id } = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Pre-footer',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(id, 'e2e');
  await withInvoker(async (invoker) => {
    const page = (
      path: string,
      document: { title: Record<string, string> } & Record<string, unknown>
    ) => published(invoker, principal, path, document);
    await page('over', { title: text('Over ons', 'About us') });
    await page('teken', { title: text('Teken de petitie', 'Sign the petition'), prefooter: false });
    const zone = await page('blijf-op-de-hoogte', {
      profile: 'zone',
      title: text('Blijf op de hoogte', 'Stay informed'),
      blocks: [
        {
          type: 'cta',
          version: 1,
          props: {
            variant: 'band',
            title: text('Doe mee', 'Join us'),
            body: text('Eén mail per maand.', 'One e-mail a month.'),
            actions: [
              { label: text('Aanmelden', 'Sign up'), target: { kind: 'url', url: '/signup' } },
            ],
          },
        },
      ],
    });
    const saved = await invoker.run(useCases.updateNavigation, principal, {
      baseRevisionId: null,
      document: {
        menus: [],
        placements: {
          main: null,
          actions: null,
          footer: [],
          legal: null,
          prefooter: { itemId: zone },
        },
      },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishNavigation, principal, {
        revisionId: saved.revisionId!,
        locale,
      });
  });
  return slug;
}

async function published(
  invoker: Invoker,
  principal: Principal,
  slug: string,
  document: { title: Record<string, string> } & Record<string, unknown>
): Promise<string> {
  const { item, revision } = await invoker.run(useCases.createItem, principal, {
    slug,
    document: {
      type: 'page' as const,
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      blocks: [],
      ...document,
    } as never,
  });
  for (const locale of ['nl', 'en'])
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale,
    });
  return item.id;
}

async function measure(page: Page, label: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label });
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, `${label} at 320 px and 200% text`, '.prefooter');
  await setTextSize(page, '');
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Zones in the admin: the list, "New zone", and the choice under Placements. */
async function exerciseZoneAdmin(page: Page) {
  const title = `Zone ${randomBytes(4).toString('hex')}`;
  await login(page, '/admin/probe/content?type=page&profile=zone', undefined, {
    'accept-language': 'en',
  });
  await expect(page.locator('h1')).toHaveText('Zones');
  await page.getByRole('button', { name: 'New zone', exact: true }).first().click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  await editorReady(page);
  await page.locator('#title\\.nl').fill(title);
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: 'Save', exact: true }).first().click()
  );
  await expect(page.locator('a[aria-current="page"]', { hasText: 'Zones' })).toHaveCount(1);
  // A zone has no pre-footer of its own to switch off.
  await expect(page.locator('#noPrefooter')).toHaveCount(0);
  await page.goto('/admin/probe/navigation/placements');
  await expect(page.locator('#placement-prefooter option', { hasText: title })).toHaveCount(1);
}

export async function exercisePrefooter(page: Page) {
  await exerciseZoneAdmin(page);
  const slug = await seed();

  await page.goto(`/${slug}/over`);
  const zone = page.getByRole('complementary', { name: 'Blijf op de hoogte' });
  await expect(zone).toContainText('Eén mail per maand.');
  // Right after the content, outside the main landmark.
  await expect(page.locator('main.page + aside.prefooter')).toHaveCount(1);
  await measure(page, 'page with pre-footer');

  await page.goto(`/${slug}/en/over`);
  await expect(page.getByRole('complementary', { name: 'Stay informed' })).toContainText(
    'One e-mail a month.'
  );
  // Switched off on the petition, and the zone itself has no address.
  await page.goto(`/${slug}/teken`);
  await expect(page.locator('h1')).toHaveText('Teken de petitie');
  await expect(page.locator('aside.prefooter')).toHaveCount(0);
  expect((await page.goto(`/${slug}/blijf-op-de-hoogte`))?.status()).toBe(404);
}
