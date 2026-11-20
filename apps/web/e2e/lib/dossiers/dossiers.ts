// Dossiers (MY-260) in the admin and on the site. The edit screen's side column lists the site's
// dossier pages as boxes, with a switch for the box under the item; a dossier that went to the
// trash stays named with a remove button, since every save that still names it is refused. On the
// public side the seeded member (`e2e-dossier-lid`, scripts/e2e/probe-fixtures.mjs) shows the box
// with the dossier's title and lead. Core and database suites cover who appears in a box and
// which ids are refused; this proves the screens, with and without JavaScript.
// Rejected: a spec of its own (the e2e budget) and editing the seeded member, which the overview
// examples and their snapshots read.
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

async function measure(page: Page, label: string, within: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label });
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, `${label} at 320 px and 200% text`, within);
  await setTextSize(page, '');
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** A draft article in a dossier that has gone to the trash, and the seeded dossier's id. */
async function seed() {
  const principal = systemPrincipal(await tenantId(), 'e2e-dossiers');
  const tag = randomBytes(4).toString('hex');
  return withInvoker(async (invoker) => {
    const doc = (type: 'page' | 'article', title: string, over: object) => ({
      type,
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: title },
      blocks: [],
      ...over,
    });
    const gone = await invoker.run(useCases.createItem, principal, {
      slug: `dossier-weg-${tag}`,
      document: doc('page', `Weg ${tag}`, { profile: 'dossier' }) as never,
    });
    const member = await invoker.run(useCases.createItem, principal, {
      slug: `dossier-kies-${tag}`,
      document: doc('article', `Kies ${tag}`, { dossiers: [{ itemId: gone.item.id }] }) as never,
    });
    await invoker.run(useCases.deleteItem, principal, { itemId: gone.item.id });
    const [seeded] = (
      await invoker.run(useCases.listItems, principal, { type: 'page', slug: 'e2e-dossier' })
    ).items;
    return { principal, memberId: member.item.id, goneId: gone.item.id, dossierId: seeded!.id };
  });
}

/** The picker: choose the seeded dossier, switch the box off, remove the one in the trash. */
export async function exerciseDossierPicker(page: Page) {
  const { principal, memberId, goneId, dossierId } = await seed();
  await login(page, `/admin/probe/content/${memberId}`, undefined, { 'accept-language': 'en' });
  await editorReady(page);
  const gone = `Dossier ${goneId.slice(0, 8)} is no longer available`;
  await expect(page.locator('#dossiers .ui-notice')).toContainText(gone);
  await expect(page.getByRole('group', { name: 'Dossiers' })).toBeVisible();
  await measure(page, 'dossier picker with a dossier in the trash', '#dossiers');

  await page.locator(`#dossier-${dossierId}`).check();
  await page.locator('#noDossierBox').check();
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: `Remove: ${gone}`, exact: true }).click()
  );
  await expect(page.locator('#dossiers .ui-notice')).toHaveCount(0);
  await expect(page.locator(`#dossier-${dossierId}`)).toBeChecked();
  await expect(page.locator('#noDossierBox')).toBeChecked();
  const { revision } = await withInvoker((invoker) =>
    invoker.run(useCases.getItem, principal, { itemId: memberId })
  );
  expect(revision.document).toMatchObject({
    dossiers: [{ itemId: dossierId }],
    showDossier: false,
  });

  // A dossier page belongs to no dossier, so it has no picker.
  await page.goto(`/admin/probe/content/${dossierId}`);
  await expect(page.locator('#dossiers')).toHaveCount(0);
}

/** The box under the seeded member: the dossier's title as a link, and its lead. */
export async function exerciseDossierBox(page: Page) {
  await page.goto('/probe/articles/e2e-dossier-lid');
  const box = page.getByRole('region', { name: 'Betaalbaar wonen' });
  await expect(box).toContainText('Onderdeel van het dossier');
  await expect(box).toContainText('Alles over wonen in de wijk.');
  await expect(box.getByRole('link', { name: 'Betaalbaar wonen' })).toHaveAttribute(
    'href',
    '/probe/e2e-dossier'
  );
  await measure(page, 'article with a dossier box', '.dossier-box');
  await page.goto('/probe/en/articles/e2e-dossier-lid');
  await expect(page.getByRole('region', { name: 'Affordable housing' })).toContainText(
    'Part of the dossier'
  );
}
