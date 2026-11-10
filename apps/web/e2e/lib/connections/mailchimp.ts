// One real native/enhanced ownership flow, using a loopback Mailchimp HTTP fixture and the
// public form route. No direct provider write substitutes for the form's connection intent.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant, closeTenantWork } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';
import { login } from '../login';
import { pastMinimumFillTime } from '../form';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { expectNoAxeViolations } from '../axe';
const key = `${'a'.repeat(32)}-us7`;
export async function mailchimpFlow(page: Page, request: APIRequestContext, locale: string) {
  const measure = async (state: string) => {
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, `Mailchimp ${state} at 320px / 200%`, 'main');
    await expectNoAxeViolations(page);
    const screenshot = `.scratch/mailchimp-${state}-${locale}-${test.info().project.name}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await test
      .info()
      .attach(`mailchimp-${state}-320-200`, { path: screenshot, contentType: 'image/png' });
    await setTextSize(page, '100%');
  };
  const slug = `chimp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await asOwner((db) =>
    testTenant(db, slug, { locales: ['nl', 'en'], platformDomain: process.env['PLATFORM_DOMAIN']! })
  );
  try {
    const principal = systemPrincipal(tenant.id, 'mailchimp-e2e');
    const external = locale === 'en';
    const owner = external ? 'external' : 'mycel';
    const operator = `${slug}@probe.test`;
    await withInvoker((i) =>
      i.run(useCases.inviteMember, principal, { email: operator, capabilities: ['tenant:admin'] })
    );
    await login(page, `/admin/${slug}/forms`, operator, { 'accept-language': locale });
    await page.locator('form[action="?/create"] select').selectOption('signup');
    await page.locator('form[action="?/create"] button').click();
    await expect(page).toHaveURL(/\/forms\/[a-f0-9-]+$/);
    const formId = page.url().split('/').pop()!;
    await page.goto(`/admin/${slug}/connections`);
    await page
      .getByText(locale === 'nl' ? 'Mailchimp verbinden' : 'Connect Mailchimp', { exact: true })
      .click();
    await page.locator('form[action="?/inspect"] [name=secret]').fill(key);
    await page.locator('form[action="?/inspect"] button').click();
    const create = page.locator('form[action="?/mailchimp"]');
    await expect(create).toBeVisible();
    await measure('account-audience');
    await create.locator('[name=audience]').selectOption('synthetic');
    for (const [name, value] of Object.entries({
      secret: key,
      externalOwner: 'Synthetic owner',
      maintainer: 'Synthetic maintainer',
      purpose: `Mailchimp ${slug}`,
      consentScopes: 'news',
    }))
      await create.locator(`[name=${name}]`).fill(value);
    await create.locator('[name=confirmationOwner]').selectOption(owner);
    await create.locator('button').click();
    await expect(page).toHaveURL(/\/connections\/[a-f0-9-]+\?created=1$/);
    const connectionId = new URL(page.url()).pathname.split('/').pop()!;
    const edit = page.locator('form[action="?/update"]');
    await edit.locator('summary').click();
    await edit.locator(`input[name=formIds][value="${formId}"]`).check();
    await edit.locator('button').click();
    await page
      .getByRole('button', { name: locale === 'nl' ? 'Aflevering hervatten' : 'Resume delivery' })
      .click();
    const callback = await page.locator('section code').innerText();
    await measure('connection');
    const c = await withInvoker((i) =>
      i.run(useCases.getConnection, principal, { id: connectionId })
    );
    await page.goto(`/admin/${slug}/forms/${formId}`);
    const feed = page.locator('form[action="?/feed"]').last();
    await feed.locator('xpath=..').locator('summary').first().click();
    await feed.locator('[name=id]').fill('newsletter');
    await feed.locator('[name=enabled]').check();
    await feed.locator('[name=connectionId]').selectOption(connectionId);
    await feed.locator('[name=connectionVersion]').fill(String(c.version));
    await feed.locator('[name=confirmationOwner]').selectOption(owner);
    await feed.locator('button[value=feed]').click();
    await expect(page.locator('[role=alert]')).toHaveCount(0);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    const saved = page
      .locator('form[action="?/feed"]')
      .filter({ has: page.locator('input[name=id][value=newsletter]') });
    await saved.locator('xpath=..').locator('summary').first().click();
    await measure('feed');
    await withInvoker(async (i) => {
      const created = await i.run(useCases.createItem, principal, {
        slug: 'join',
        document: {
          type: 'page',
          title: { nl: 'Nieuwsbrief', en: 'Newsletter' },
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          blocks: [{ type: 'form', version: 1, props: { formId } }],
        },
      });
      for (const language of ['nl', 'en'])
        await i.run(useCases.publishItem, principal, {
          itemId: created.item.id,
          revisionId: created.revision.id,
          locale: language,
        });
    });
    await page.goto(`/${slug}/${external ? 'en/' : ''}join`);
    const email = `visitor-${slug}@probe.test`;
    await page.locator('main form [name=email]').fill(email);
    await page.locator('main form [name=consent]').check();
    await pastMinimumFillTime(page);
    await page.locator('main form button[type=submit]').click();
    const hash = createHash('md5').update(email).digest('hex');
    const fixture = process.env['MAILCHIMP_FIXTURE_ORIGIN']!;
    const provider = async () => {
      const response = await request.get(`${fixture}/3.0/lists/synthetic/members/${hash}`);
      return response.ok() ? response.json() : null;
    };
    if (external) {
      await expect.poll(async () => (await provider())?.status).toBe('pending');
      await request.post(`${fixture}/control/${hash}`, {
        data: { status: 'subscribed', timestamp_opt: new Date().toISOString() },
      });
      expect(
        (await request.post(callback, { form: { 'data[id]': hash, type: 'subscribe' } })).status()
      ).toBe(204);
    } else {
      const dir = process.env['MAIL_SPOOL_DIR']!;
      const mail = () =>
        readdirSync(dir)
          .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))
          .find((m) => m.to.email === email);
      await expect.poll(mail).toBeTruthy();
      const url = /https?:\/\/\S+\/confirm\?token=\S+/.exec(mail().text)?.[0];
      expect(url).toBeTruthy();
      await page.goto(url!);
      await page.locator('main form button').click();
      await expect.poll(async () => (await provider())?.status).toBe('subscribed');
    }
    await expect
      .poll(() =>
        withInvoker(
          async (_i, uow) =>
            (await uow.run(principal, (ctx) => ctx.supporters.getProjection(email)))?.lists ?? []
        )
      )
      .toContain('news');
    await request.post(`${fixture}/control/${hash}`, { data: { status: 'unsubscribed' } });
    expect(
      (await request.post(callback, { form: { 'data[id]': hash, type: 'unsubscribe' } })).status()
    ).toBe(204);
    await expect
      .poll(() =>
        withInvoker(
          async (_i, uow) =>
            (await uow.run(principal, (ctx) => ctx.supporters.getProjection(email)))?.lists ?? []
        )
      )
      .toEqual([]);
    if (external) {
      const directory = process.env['MAIL_SPOOL_DIR']!;
      expect(
        readdirSync(directory)
          .map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')))
          .filter((m) => m.to.email === email)
      ).toEqual([]);
    }
    await page.goto(`/admin/${slug}/connections/${connectionId}`);
    await expect(page.locator('#attempts-table')).toContainText(
      locale === 'nl' ? 'Uitgeschreven' : 'Unsubscribed'
    );
    await measure('delivery-status');
  } finally {
    await asOwner((db) => closeTenantWork(db, [tenant.id]));
  }
}
