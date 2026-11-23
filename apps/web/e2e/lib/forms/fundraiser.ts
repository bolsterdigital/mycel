// A fundraiser end to end (ADR 033 rule 8, amendment 2026-11-17), against the fake payment
// provider: the editor starts one from the campaigns screen with a goal in euros, opens
// participation from the panel, the landing and full card share the form, and a visitor gives
// through the card. The card and campaigns list show the money against the goal. Works alike
// in the no-js project. The core record is `packages/core/src/campaigns/fundraiser.test.ts`.

import { expect, test, type Page } from '@playwright/test';
import { BLOCK_DEFINITIONS as DEFS, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { pastMinimumFillTime } from '../form';
import { layoutGate, setTextSize } from '../layout';
import { forwarded, login } from '../login';
import { isA11y } from '../project';
import { payGift } from './donation';

/** "€ 25 van € 100" with whatever space the locale puts after the sign. */
const ofGoal = (count: number, goal: number) => new RegExp(`€\\s?${count} van €\\s?${goal}`);

async function checkLayout(page: Page, slug: string, view: string) {
  await page.goto(`/probe/${slug}`);
  const form = page.locator('.campaign-action form');
  await expect(form.getByLabel('Voornaam')).toBeVisible();
  await expect(form.getByLabel('Achternaam')).toBeVisible();
  await expect(form.getByRole('radio', { name: /2[.]500/ })).toBeVisible();
  if (!isA11y()) return;
  for (const [width, size] of [
    [1366, '100%'],
    [390, '100%'],
    [320, '100%'],
    [320, '200%'],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    await setTextSize(page, size);
    if (width === 320) await form.getByRole('radio', { name: 'Anders' }).check();
    await layoutGate(page, `${view} at ${width}px / ${size}`, '.campaign-action form');
    const tiles = await form.locator('.amount-choice').evaluateAll((labels) =>
      labels.map((label) => {
        const { width, height, y } = label.getBoundingClientRect();
        return { y, fits: width >= 44 && height >= 44 && label.scrollWidth <= width + 1 };
      })
    );
    expect(
      tiles.every(({ fits }) => fits),
      `${view} at ${width}px / ${size}`
    ).toBe(true);
    if (width !== 320 || size === '200%') {
      // The card's narrower desktop column uses the same two-tile fallback as mobile.
      const rows = size === '200%' ? 4 : width === 1366 && view === 'landing' ? 1 : 2;
      expect(new Set(tiles.map(({ y }) => y)).size, `${view} at ${width}px / ${size}`).toBe(rows);
    }
    const labelsShareRow = await form
      .getByLabel('Voornaam')
      .evaluate(
        (input) =>
          input.getBoundingClientRect().y ===
          input.closest('form')!.querySelector('[name="last"]')!.getBoundingClientRect().y
      );
    expect(labelsShareRow, `${view} at ${width}px / ${size}`).toBe(width === 1366);
    if (width === 320) {
      await form.screenshot({
        path: test.info().outputPath(`${view}-320-${size === '200%' ? 200 : 100}.png`),
      });
    }
  }
  await expectNoAxeViolations(page, { label: `${view} fundraiser form` });
  await setTextSize(page, '16px');
}

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
    const { form, version } = await invoker.run(useCases.getFormForAuthoring, editor, {
      id: campaign!.formId!,
    });
    await invoker.run(useCases.updateForm, editor, {
      baseVersion: version,
      value: {
        ...form,
        fields: [
          {
            name: 'first',
            type: 'text',
            layout: 'half',
            label: { nl: 'Voornaam' },
            required: true,
          },
          {
            name: 'last',
            type: 'text',
            layout: 'half',
            label: { nl: 'Achternaam' },
            required: true,
          },
          ...form.fields.map((field) =>
            field.type === 'amount' ? { ...field, presets: [25, 250, 2500] } : field
          ),
        ],
      },
    });
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
            props: { campaignId: campaign!.id, variant: 'full', width: 'wide' },
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
  await visitor.context().setExtraHTTPHeaders(forwarded());
  await checkLayout(visitor, slug, 'landing');
  await checkLayout(visitor, host, 'card');
  const preset = visitor.getByRole('radio', { name: /^€\s?25$/ });
  await preset.check();
  await preset.press('ArrowLeft');
  const other = visitor.getByRole('radio', { name: 'Anders' });
  await expect(other).toBeChecked();
  const custom = visitor.getByLabel('Ander bedrag (€)');
  await custom.fill('geen bedrag');
  await visitor.getByLabel('Voornaam').fill('Sam');
  await visitor.getByLabel('Achternaam').fill('Van Dam');
  await visitor.getByLabel('E-mailadres').fill(`gever-${slug}@example.org`);
  await pastMinimumFillTime(visitor);
  await visitor.getByRole('button', { name: 'Doneer' }).click();
  await expect(visitor.getByRole('alert').getByRole('link')).toHaveAttribute('href', /-custom$/);
  await visitor.getByRole('alert').getByRole('link').click();
  await expect(custom).toBeFocused();
  await expect(other).toBeChecked();
  await expect(custom).toHaveValue('geen bedrag');
  await expect(visitor.getByLabel('Achternaam')).toHaveValue('Van Dam');
  await preset.check();
  await expect(custom).toBeHidden();
  await payGift(visitor, 'Betaald');
  await expect(visitor.getByRole('heading', { name: 'Dank je wel voor je gift' })).toBeVisible();
  await expect(visitor.getByText(/Bedrag: €\s?25$/)).toBeVisible();

  // The card counts the paid gift against the goal, in euros; the bar measures the same.
  await visitor.goto(`/probe/${host}`);
  await visitor.reload();
  // The stacked counter shows the figure and the goal apart (ADR 038 rule 7).
  await expect(visitor.locator('.campaign-count strong')).toHaveText(/^€\s?25$/);
  await expect(visitor.locator('.campaign-count-goal')).toHaveText(/Doel: €\s?100/);
  await expect(visitor.locator('progress')).toHaveAttribute('value', '2500');
  await expect(visitor.locator('progress')).toHaveAttribute('max', '10000');
  if (isA11y()) await expectNoAxeViolations(visitor, { label: 'fundraiser card' });

  await page.goto('/admin/probe/campaigns');
  await expect(
    page.getByRole('row').filter({ hasText: `Geef voor het park ${slug}` })
  ).toContainText(ofGoal(25, 100));
}
