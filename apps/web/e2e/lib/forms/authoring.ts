// The form-admin task is kept beside its fixture, rather than expanding the access spec's copy.
import { test, expect, type Page } from '@playwright/test';
import { login } from '../login';
import { layoutGate, setTextSize, NARROW } from '../layout';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { testTenant, closeTenantWork } from '@mycel/db/testing';
import { uuidv7 } from '@mycel/db';
import { systemPrincipal, useCases } from '@mycel/core';
export async function authorForm(page: Page, locale: string) {
  const slug = `forms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await asOwner((db) =>
    testTenant(db, slug, { locales: ['nl', 'en'], platformDomain: process.env['PLATFORM_DOMAIN']! })
  );
  const principal = systemPrincipal(tenant.id, 'form-admin-e2e');
  const email = `${slug}@probe.test`;
  await withInvoker((i) =>
    i.run(useCases.inviteMember, principal, { email, capabilities: ['tenant:admin'] })
  );
  await login(page, `/admin/${slug}/forms`, email, { 'accept-language': locale });
  await page.locator('form[action="?/create"] select').selectOption('signup');
  await page.locator('form[action="?/create"] button').click();
  await expect(page).toHaveURL(/\/forms\/[a-f0-9-]+$/);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  const formId = page.url().split('/').pop()!;
  const field = page
    .locator('details')
    .filter({ has: page.locator('input[name="fieldId"][value=""]') })
    .first();
  await field.locator('summary').first().click();
  await field.locator('[name="id"]').fill('topic');
  await field.locator('[name="name"]').fill('topic');
  await field.locator('[name="type"]').selectOption('text');
  await field.locator('[name="label.nl"]').fill('Onderwerp');
  await field.locator('[name="label.en"]').fill('Topic');
  await field.locator('[name="command"][value="field"]').click();
  const topic = page
    .locator('details')
    .filter({ has: page.locator('input[name="fieldId"][value="topic"]') })
    .first();
  await topic.locator('summary').first().click();
  await expect(topic.locator('[name="label.en"]')).toHaveValue('Topic');
  const mail = page
    .locator('form[action="?/mail"]')
    .filter({ has: page.locator('[name="command"][value="mailSettings"]') });
  await mail.locator('[name="enabled"]').check();
  await mail.locator('button').click();
  const feed = page
    .locator('details')
    .filter({ has: page.locator('form[action="?/feed"]') })
    .last();
  await feed.locator('summary').first().click();
  await feed.locator('[name="id"]').fill('news');
  await feed.locator('[name="command"][value="feed"]').click();
  await expect(page.locator('main')).toContainText('news');
  await configureMessages(page);
  const preview = page.locator('form[action="?/preview"]');
  await preview.locator('[name="sample.email"]').fill('synthetic@example.org');
  await preview.locator('[name="sample.topic"]').fill('question');
  await preview.locator('[name="sample.consent"]').check();
  await preview.locator('button').click();
  await expect(page.locator('main')).toContainText('Alpha');
  await expect(page.locator('main')).toContainText('Beta');
  // A leased historical attempt is a stable recovery fixture: its real event cannot send twice.
  await withInvoker(async (i, uow) => {
    const { form: definition, version } = await i.run(useCases.getForm, principal, { id: formId });
    const submissionId = uuidv7(),
      eventId = uuidv7();
    await uow.run(principal, async (c) => {
      await c.submissions.insert({
        id: submissionId,
        formId,
        values: { email: 'synthetic@example.org', consent: true, topic: 'question' },
        locale: 'en',
        pageUrl: null,
        ipHash: null,
        createdAt: new Date(),
        confirmedAt: null,
        list: definition.list,
        consentTextVersion: definition.consentTextVersion,
        evaluation: {
          version,
          definition,
          activeFieldIds: definition.fields.map((f) => f.id ?? f.name),
          requiredFieldIds: ['email', 'consent'],
          discardedFieldIds: [],
          mailActions: [
            {
              actionId: 'question',
              version: 'synthetic-v1',
              eventId,
              recipient: 'team@example.org',
            },
          ],
        },
      });
      await c.events.publish({
        id: eventId,
        tenantId: tenant.id,
        type: 'form.mail.planned',
        occurredAt: new Date(),
        actor: principal.actor,
        props: {
          submissionId,
          email: 'synthetic@example.org',
          formId,
          actionId: 'question',
          actionVersion: 'synthetic-v1',
          kind: 'notification',
          locale: 'en',
          recipient: 'team@example.org',
          copy: {
            subject: 'Alpha',
            text: 'Hello question',
            sources: { subject: 'tenant', text: 'tenant' },
          },
        },
      });
      await c.mailSends.claim(
        {
          key: `forms.mail:${eventId}`,
          subscriber: 'forms.mail',
          eventId,
          correlation: 'a'.repeat(64),
        },
        { at: new Date(), until: new Date(Date.now() + 3600000), expected: null }
      );
    });
  });
  await page.reload();
  const recovery = page
    .locator('details')
    .filter({ has: page.locator('form[action="?/replay"]') })
    .first();
  await recovery.locator('summary').first().click();
  await recovery.locator('button').click();
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  // Open only top-level disclosures; nested condition editors retain their native state.
  await page
    .locator('main > section > details')
    .evaluateAll((ds) => ds.forEach((d) => d.setAttribute('open', '')));
  await layoutGate(page, 'form administration at 320px / 200%', 'main');
  await expectNoAxeViolations(page);
  const screenshot = `.scratch/form-admin-${locale}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  await test.info().attach('form-admin-320-200', { path: screenshot, contentType: 'image/png' });
  await asOwner((db) => closeTenantWork(db, [tenant.id]));
  return formId;
}

async function configureMessages(page: Page) {
  for (const [id, subject, topic] of [
    ['question', 'Alpha', 'question'],
    ['other', 'Beta', 'other'],
  ]) {
    const template = page
      .locator('form[action="?/mail"]')
      .filter({ has: page.locator('input[name="command"][value="template"]') })
      .filter({ has: page.locator('input[name="id"]:not([readonly])') });
    await template.locator('..').locator('summary').first().click();
    await template.locator('[name="id"]').fill(id!);
    for (const lang of ['nl', 'en']) {
      await template.locator(`[name="subject.${lang}"]`).fill(subject!);
      await template.locator(`[name="text.${lang}"]`).fill('Hello {{field:topic}}');
    }
    await template.locator('button').click();
    const action = page
      .locator('form[action="?/mail"]')
      .filter({ has: page.locator('button[value="action"]') })
      .filter({ has: page.locator('input[name="id"]:not([readonly])') });
    await action.locator('..').locator('summary').first().click();
    await action.locator('[name="id"]').fill(id!);
    await action.locator('[name="enabled"]').check();
    await action.locator('[name="recipients"]').fill('team@example.org');
    await action.locator('[name="templateId"]').selectOption(id!);
    await action.locator('[name="when.mode"]').selectOption('atom');
    await action.locator('fieldset details > summary').click();
    await action.locator('[name="when.0.field"]').selectOption('topic');
    await action.locator('[name="when.0.value"]').fill(topic!);
    await action.locator('button[value="action"]').click();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  }
}
