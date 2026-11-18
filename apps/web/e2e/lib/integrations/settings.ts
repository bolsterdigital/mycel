// The integration setting in the admin (docs/reference/integrations.md): an
// administrator switches YouTube and Google Tag Manager on under General, with the container and
// the vendors its tags may reach; a container id that is not one is refused and nothing is
// written; switching the tag manager off keeps its values. An editor sees no section and a post by
// hand is refused. Core proves validation, versions and tenant isolation; this proves the screen
// hands them over, without JavaScript in `no-js`.
import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_INTEGRATIONS,
  UseCaseError,
  capabilitiesFor,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { login } from '../login';

export async function exerciseIntegrationSettings(page: Page, baseURL: string) {
  const suffix = test.info().project.name;
  const slug = `site-integrations-${suffix}`;
  const admin = `site-integrations-${suffix}@probe.test`;
  const editor = `site-integrations-editor-${suffix}@probe.test`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Integrations',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  const stored = () =>
    withInvoker((invoker) => invoker.run(useCases.getIntegrationSettings, system, {}));
  const reset = async () => {
    const { version } = await stored();
    await withInvoker((invoker) =>
      invoker.run(useCases.updateIntegrationSettings, system, {
        baseVersion: version,
        settings: DEFAULT_INTEGRATIONS,
      })
    );
  };
  await withInvoker(async (invoker) => {
    for (const [email, capabilities] of [
      [admin, ['tenant:admin']],
      [editor, capabilitiesFor('editor')],
    ] as const)
      try {
        await invoker.run(useCases.inviteMember, system, {
          email,
          capabilities: [...capabilities],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
  });
  await reset();
  const section = page.getByRole('region', { name: 'Integraties' });
  const save = section.getByRole('button', { name: 'Integraties opslaan' });
  try {
    await login(page, `/admin/${slug}/site`, admin);
    await expect(section).toContainText('Op deze site laadt niets van andere diensten.');
    await expectNoAxeViolations(page);

    await section.getByLabel('Video’s van YouTube in de pagina afspelen').check();
    await section.getByLabel('Google Tag Manager laden na toestemming').check();
    await section.getByLabel('Container-ID').fill(' gtm-proef41 ');
    await section.getByLabel('Meta Pixel').check();
    await save.click();
    await expect(section).toContainText('Instellingen opgeslagen.');
    await expect(section).toContainText('Aan: YouTube, Google Tag Manager.');
    expect((await stored()).value).toEqual({
      ...DEFAULT_INTEGRATIONS,
      youtube: { enabled: true },
      'google-tag-manager': {
        enabled: true,
        containerId: 'GTM-PROEF41',
        category: 'marketing',
        vendors: ['meta-pixel'],
      },
    });
    await expectNoAxeViolations(page);

    // A script address is not a container id: refused, nothing written.
    const before = await stored();
    await page.goto(`/admin/${slug}/site`);
    await section
      .getByLabel('Container-ID')
      .fill('https://www.googletagmanager.com/gtm.js?id=GTM-X');
    await save.click();
    await expect(page.getByText('Er is een probleem')).toBeVisible();
    expect(await stored()).toEqual(before);

    // The kill switch keeps the container for later.
    await page.goto(`/admin/${slug}/site`);
    await section.getByLabel('Google Tag Manager laden na toestemming').uncheck();
    await save.click();
    await expect(section).toContainText('Aan: YouTube.');
    expect((await stored()).value['google-tag-manager']).toMatchObject({
      enabled: false,
      containerId: 'GTM-PROEF41',
    });

    // An editor decides content, not which third party runs on the site.
    await page.context().clearCookies();
    await login(page, `/admin/${slug}/site`, editor);
    await expect(page.getByRole('heading', { level: 2, name: 'Tijdzone' })).toBeVisible();
    await expect(section).toHaveCount(0);
    const post = await page.request.post(`/admin/${slug}/site?section=general&/integrations`, {
      headers: { origin: baseURL, 'content-type': 'application/x-www-form-urlencoded' },
      data: `baseVersion=${(await stored()).version}&vimeo=on`,
      maxRedirects: 0,
    });
    expect(post.status()).toBe(403);
    expect((await stored()).value.vimeo).toEqual({ enabled: false });
  } finally {
    await reset();
  }
}
