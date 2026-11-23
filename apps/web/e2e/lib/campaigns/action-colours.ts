// MY-293: the public landing and full card take the same colours from a real site theme.
// Computed paint checks the active media query and consuming selectors, which tokens alone miss.
import { DEFAULT_THEME, systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { campaignCardFixture } from '../blocks/campaigns';
import { asOwner, withInvoker } from '../invoker';
import { layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

const colours = {
  light: {
    campaignForm: { foreground: '#142338', background: '#9ad7ee' },
    campaignProgress: { foreground: '#16263b', background: '#f5f7fa' },
    campaignProgressFill: '#304865',
  },
  dark: {
    campaignForm: { foreground: '#e7fbff', background: '#164b58' },
    campaignProgress: { foreground: '#eaf1fa', background: '#202938' },
    campaignProgressFill: '#77d5ec',
  },
};

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;

export async function exerciseCampaignActionColours(page: Page, stamp: string) {
  const slug = `paint-${stamp}`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Campaign colours',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const { ids, campaignAction } = await campaignCardFixture(stamp, tenant.id);
  await campaignAction('openCampaign');
  const principal = systemPrincipal(tenant.id, 'e2e');

  for (const configured of [false, true]) {
    if (configured) {
      await withInvoker(async (invoker) => {
        await invoker.run(useCases.updateSiteTheme, principal, {
          baseVersion: 0,
          theme: {
            ...DEFAULT_THEME,
            palettes: {
              light: { ...DEFAULT_THEME.palettes.light, ...colours.light },
              dark: { ...DEFAULT_THEME.palettes.dark, ...colours.dark },
            },
          },
        });
        const campaignId = ids.c.id;
        const { updatedAt } = await invoker.run(useCases.getCampaign, principal, { campaignId });
        await invoker.run(useCases.updateCampaign, principal, {
          campaignId,
          baseUpdatedAt: updatedAt,
          startingCount: 125,
        });
      });
    }

    for (const path of [`/${slug}/kaart-${stamp}`, `/${slug}/gast-${stamp}`]) {
      expect((await page.goto(path))?.status()).toBe(200);
      const action = page.locator('.campaign-layout > .campaign-action');
      const count = action.locator('.campaign-count');
      const progress = count.locator('progress');
      await expect(progress).toHaveAttribute('value', configured ? '125' : '0');
      await expect(progress).toHaveAttribute('max', '500');
      await expect(action.locator('form[method="post"]')).toHaveCount(1);

      for (const mode of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: mode });
        const palette = DEFAULT_THEME.palettes[mode];
        const form = configured ? colours[mode].campaignForm : palette.surface;
        const band = configured ? colours[mode].campaignProgress : palette.body;
        const fill = configured ? colours[mode].campaignProgressFill : band.foreground;
        await expect(action).toHaveCSS('background-color', rgb(form.background));
        await expect(action).toHaveCSS('color', rgb(form.foreground));
        await expect(count).toHaveCSS('background-color', rgb(band.background));
        await expect(count).toHaveCSS('color', rgb(band.foreground));
        await expect(progress).toHaveCSS('background-color', rgb(band.background));
        // The native progress fill is a browser-internal pseudo-element. Sample inside it
        // at 12.5% of the track, safely clear of the rounded ends and the 25% fill edge.
        const { data, info } = await sharp(await progress.screenshot({ scale: 'css' }))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const pixel = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 8)) * 3;
        expect(`rgb(${[...data.subarray(pixel, pixel + 3)].join(', ')})`).toBe(
          rgb(configured ? fill : band.background)
        );

        for (const [width, text] of [
          [1366, '16px'],
          [390, '16px'],
          [320, '16px'],
          [320, '200%'],
        ] as const) {
          await page.setViewportSize({ width, height: 900 });
          await setTextSize(page, text);
          await layoutGate(page, `${path} ${mode} ${width}px ${text}`, 'main');
          if (configured && mode === 'light' && width === 320 && isA11y()) {
            const view = path.includes('/kaart-') ? 'landing' : 'full-card';
            const size = text === '200%' ? '200-percent' : 'default';
            const screenshot = test.info().outputPath(`${view}-320px-${size}.png`);
            await action.screenshot({ path: screenshot, scale: 'css' });
            await test.info().attach(`${view} at 320px, ${text}`, {
              path: screenshot,
              contentType: 'image/png',
            });
          }
        }
        await setTextSize(page, '16px');
        if (configured && isA11y()) await expectNoAxeViolations(page, { label: `${path} ${mode}` });
      }
    }
  }
}
