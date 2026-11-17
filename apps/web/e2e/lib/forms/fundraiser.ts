// A fundraiser end to end (ADR 033 rule 8, amendment 2026-11-17), against the fake payment
// provider: the editor starts one from the campaigns screen with a goal in euros, opens
// participation from the panel, a visitor gives on the landing page and pays, and a card on
// another page and the campaigns list then show the money against the goal. Works the same in
// the no-js project. The core record is `packages/core/src/campaigns/fundraiser.test.ts`.

import { expect, type Page } from '@playwright/test';
import { BLOCK_DEFINITIONS as DEFS, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { login } from '../login';
import { isA11y } from '../project';
import { give } from './donation';

/** "€ 25 van € 100" with whatever space the locale puts after the sign. */
const ofGoal = (count: number, goal: number) => new RegExp(`€\\s?${count} van €\\s?${goal}`);

export async function exerciseFundraiser(page: Page, project: string): Promise<void> {
  const slug = `inzameling-${project}-${Date.now()}`;
  await login(page, '/admin/probe/campaigns');
  await page.getByRole('link', { name: 'Nieuwe campagne' }).first().click();
  await page.getByRole('radio', { name: 'Fondsenwerving' }).check();
  await page.getByLabel('Titel (nl)').fill(`Geef voor het park ${slug}`);
  await page.getByLabel('Titel (en)').fill('Give for the park');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Doel').fill('100');
  await page.getByRole('button', { name: 'Campagne starten' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]+\?campaign=created#campaign$/);
  const itemId = /content\/([0-9a-f-]+)/.exec(page.url())![1]!;
  const panel = page.locator('#campaign');
  await expect(panel.getByRole('heading', { name: 'Fondsenwerving' })).toBeVisible();
  await expect(panel.getByText(ofGoal(0, 100))).toBeVisible();
  await expect(panel.getByLabel('Doel', { exact: true })).toHaveValue('100');

  // Publish the landing page and place a card for the campaign on another page.
  const editor = systemPrincipal(await tenantId(), 'e2e-fundraiser');
  const host = `${slug}-kaart`;
  await withInvoker(async (invoker) => {
    const { item } = await invoker.run(useCases.getItem, editor, { itemId });
    await invoker.run(useCases.publishItem, editor, {
      itemId,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
    const { campaign } = await invoker.run(useCases.getLandingCampaign, editor, { itemId });
    const card = await invoker.run(useCases.createItem, editor, {
      slug: host,
      document: {
        type: 'page',
        title: { nl: 'Doe mee' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [
          {
            type: 'campaign-card',
            version: DEFS['campaign-card'].version,
            props: { campaignId: campaign!.id, variant: 'compact', width: 'content' },
          },
        ],
      },
    });
    await invoker.run(useCases.publishItem, editor, {
      itemId: card.item.id,
      revisionId: card.revision.id,
      locale: 'nl',
    });
  });
  await page.goto(`/admin/probe/content/${itemId}`);
  await panel.getByRole('button', { name: 'Deelname openen' }).click();
  await expect(panel.getByText('Deelname is open.')).toBeVisible();

  const visitor = await page.context().newPage();
  await give(visitor, slug, `gever-${slug}@example.org`, { preset: /25/ }, 'Betaald');
  await expect(visitor.getByRole('heading', { name: 'Dank je wel voor je gift' })).toBeVisible();

  // The card counts the paid gift against the goal, in euros; the bar measures the same.
  await visitor.goto(`/probe/${host}`);
  await visitor.reload();
  await expect(visitor.locator('.campaign-count strong')).toHaveText(ofGoal(25, 100));
  await expect(visitor.locator('progress')).toHaveAttribute('value', '2500');
  await expect(visitor.locator('progress')).toHaveAttribute('max', '10000');
  if (isA11y()) await expectNoAxeViolations(visitor, { label: 'fundraiser card' });

  await page.goto('/admin/probe/campaigns');
  await expect(
    page.getByRole('row').filter({ hasText: `Geef voor het park ${slug}` })
  ).toContainText(ofGoal(25, 100));
}
