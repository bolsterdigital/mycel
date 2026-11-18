// An accepted signup counted end to end (docs/reference/analytics.md § How an accepted signup is
// counted): a visitor signs up on a site of its own that measures, and the worker's Plausible
// transport posts one event to the loopback Plausible (scripts/e2e/plausible-fixture.mjs). What
// arrived is read back from the fixture: the catalogue event on the site root, Mycel's own user
// agent and no visitor header, address or form. With Plausible down (503) the form is accepted
// all the same and the worker tries exactly twice. Core proves the intent and the claim; the
// adapter's tests prove each answer; this proves the composed worker sends what they promise.
import { expect, test, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { pastMinimumFillTime } from '../form';
import { asOwner, withInvoker } from '../invoker';

interface Received {
  event: Record<string, unknown>;
  headers: Record<string, string>;
}

export async function exerciseCountedSignup(page: Page, baseURL: string) {
  const project = test.info().project.name;
  const stamp = Date.now().toString(36);
  const slug = `site-count-${project}`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Counted signups',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  const set = (plausibleDomain: string | null) =>
    withInvoker(async (invoker) => {
      const { version } = await invoker.run(useCases.getAnalyticsSettings, system, {});
      await invoker.run(useCases.updateAnalyticsSettings, system, {
        baseVersion: version,
        settings: { plausibleDomain },
      });
    });
  await withInvoker(async (invoker) => {
    const existing = await invoker.run(useCases.listItems, system, { slug: 'join' });
    if (existing.items.length) return;
    const form = await invoker.run(useCases.createForm, system, { kind: 'signup' });
    const { item, revision } = await invoker.run(useCases.createItem, system, {
      slug: 'join',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Doe mee' },
        blocks: [{ type: 'form', version: 1, props: { formId: form.id } }],
      },
    });
    await invoker.run(useCases.publishItem, system, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
  });
  const fixture = process.env['PLAUSIBLE_FIXTURE_ORIGIN'];
  if (!fixture)
    throw new Error('PLAUSIBLE_FIXTURE_ORIGIN is not set; run through scripts/e2e/e2e.mjs');
  const received = async (domain: string): Promise<Received[]> =>
    (await page.request.get(`${fixture}/control/events?domain=${domain}`)).json();
  const signUp = async (email: string) => {
    await page.goto(`/${slug}/join`);
    await page.locator('main form [name=email]').fill(email);
    await page.locator('main form [name=consent]').check();
    await pastMinimumFillTime(page);
    await page.locator('main form button[type=submit]').click();
    await expect(page).toHaveURL(new RegExp(`/${slug}/join/thanks$`));
  };

  const counted = `count-${project}-${stamp}.example`;
  const down = `down-${project}-${stamp}.example`;
  const email = `counted-${stamp}@probe.test`;
  try {
    await set(counted);
    await signUp(email);
    await expect.poll(async () => (await received(counted)).length, { timeout: 15_000 }).toBe(1);
    const [{ event, headers }] = (await received(counted)) as [Received];
    const primary = `http://${slug}.${process.env['PLATFORM_DOMAIN']!}:${new URL(baseURL).port}`;
    expect(event).toEqual({
      name: 'form.submitted',
      url: `${primary}/`,
      domain: counted,
      props: { kind: 'signup' },
    });
    expect(headers['user-agent']).toBe('Mycel (server event)');
    for (const header of ['x-forwarded-for', 'cookie', 'referer', 'origin'])
      expect(headers[header]).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(email);

    // Plausible down: the visitor still lands on the thanks page; the worker tries twice, no more.
    await set(down);
    await signUp(`down-${stamp}@probe.test`);
    await expect.poll(async () => (await received(down)).length, { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(1000);
    expect(await received(down)).toHaveLength(2);
    expect(await received(counted)).toHaveLength(1);
  } finally {
    await set(null);
  }
}
