// Becoming a member (MY-254 PR 4), against the fake payment provider of the e2e runner: a
// restricted article whose prompt leads to the tier's signup page, a membership form that sells
// the tier at its price, the return page that mails a sign-in link instead of signing anyone in,
// the whole article for the new member, and cancelling on `/my-giving`, after which the charge
// run ends the membership at the end of the period while the article stays open through the
// grace. The clock of the charge run is the test's own (the server's is today); the end of the
// grace itself, a revoked and an expired grant are core records (`money/membership.test.ts`,
// `content/access/access.test.ts`, the membership scenario of the adapter rules).

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chargeSubscription, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { pastMinimumFillTime } from '../form';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { forwarded, login } from '../login';
import { isA11y } from '../project';

const SITE = 'http://probe.localhost:4173';
const DAY = 24 * 60 * 60 * 1000;

const text = (t: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});

/** The newest spooled mail to `to` whose subject matches (scripts/e2e/e2e.mjs sets the dir). */
async function mailTo(to: string, subject: RegExp): Promise<{ text: string }> {
  const dir = process.env['MAIL_SPOOL_DIR'];
  if (!dir) throw new Error('MAIL_SPOOL_DIR is not set; run through scripts/e2e/e2e.mjs');
  const find = () =>
    readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .filter((m) => m.to.email === to && subject.test(m.subject));
  await expect
    .poll(() => find().length, { timeout: 15_000, message: `mail ${subject} to ${to}` })
    .toBeGreaterThan(0);
  return find().at(-1)!;
}

async function gate(page: Page, label: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label });
  const wide = page.viewportSize()!;
  await page.setViewportSize(NARROW);
  for (const size of ['200%', '16px']) {
    await setTextSize(page, size);
    await layoutGate(page, `${label} at 320px / ${size}`, 'main');
    if (size === '200%')
      await page.locator('main').screenshot({
        path: test.info().outputPath(`${label.replaceAll(' ', '-')}-320-200.png`),
      });
  }
  await page.setViewportSize(wide);
}

/** A paid tier with a monthly price, its signup page with the membership form, and an article. */
async function fixtures(project: string) {
  const id = `${project}-${randomUUID().slice(0, 8)}`;
  const principal = systemPrincipal(await tenantId(), 'e2e-membership');
  return withInvoker(async (invoker) => {
    const signup = `word-lid-${id}`;
    const tier = await invoker.run(useCases.createAccessTier, principal, {
      slug: `vrienden-${id}`,
      name: { nl: `Vrienden ${id}` },
      kind: 'paid',
      prices: { month: 500, year: 5000 },
      signupPath: `/${signup}`,
    });
    const form = await invoker.run(useCases.createForm, principal, {
      kind: 'membership',
      tierId: tier.id,
    });
    const publish = async (slug: string, document: Record<string, unknown>) => {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug,
        document: document as never,
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
    };
    await publish(signup, {
      type: 'page',
      title: { nl: 'Word lid' },
      defaultLocale: 'nl',
      locales: ['nl'],
      blocks: [{ type: 'form', version: 1, props: { formId: form.id } }],
    });
    const article = `voor-vrienden-${id}`;
    await publish(article, {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: `Voor vrienden ${id}` },
      lead: { nl: 'De lead mag iedereen lezen.' },
      blocks: [
        {
          type: 'rich-text',
          version: 1,
          props: { content: { nl: text('LEDEN-BODY voor leden.') } },
        },
      ],
      access: { level: 'tier', tierIds: [tier.id], teaser: 'lead' },
    });
    return { tier, signup, article: `/articles/${article}` };
  });
}

export async function exerciseMembership(page: Page, project: string): Promise<void> {
  const { tier, signup, article } = await fixtures(project);
  const member = `lid-${project}-${Date.now()}@example.org`;
  const principal = systemPrincipal(await tenantId(), 'e2e-membership');

  // The prompt leads to the signup page; signing in is a plain link under it.
  await page.goto(`${SITE}${article}`);
  const prompt = page.locator('.reader-gate');
  await expect(prompt.getByRole('heading', { name: 'Word lid om verder te lezen' })).toBeVisible();
  await expect(page.getByText('LEDEN-BODY')).toHaveCount(0);
  await expect(prompt.getByRole('link', { name: 'Al lid? Log in' })).toBeVisible();
  await gate(page, 'membership prompt');
  await prompt.getByRole('link', { name: 'Word lid' }).click();
  await expect(page).toHaveURL(`${SITE}/${signup}`);

  // The form sells the tier at its price; nobody types an amount.
  await page.context().setExtraHTTPHeaders(forwarded());
  const prices = page.getByRole('group', { name: `Lidmaatschap ${tier.name.nl}` });
  await expect(prices.getByRole('radio', { name: /€\s?5 per maand/ })).toBeChecked();
  await expect(prices.getByRole('radio', { name: /€\s?50 per jaar/ })).not.toBeChecked();
  await gate(page, 'membership form');
  await page.getByLabel('E-mailadres').fill(member);
  await pastMinimumFillTime(page);
  await page.getByRole('button', { name: 'Word lid' }).click();
  await expect(page).toHaveURL(/\/_pay\/fake_[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Betaald' }).click();

  // The return page welcomes the member and mails a sign-in link; it signs nobody in.
  await expect(page.getByRole('heading', { name: 'Welkom als lid' })).toBeVisible();
  await expect(page.getByText(/Je betaalt €\s?5 per maand\./)).toBeVisible();
  await gate(page, 'membership return');
  await page.getByRole('button', { name: 'Stuur me een inloglink' }).click();
  await expect(page.getByRole('status')).toContainText('inloglink');
  await expect(page.getByRole('button', { name: 'Stuur me een inloglink' })).toHaveCount(0);
  // The start mail carries the link to manage the membership; the sign-in mail its own link.
  expect((await mailTo(member, /^Welkom als lid/)).text).toContain('/my-giving/');
  const signin = /https?:\/\/\S+\/reader\/signin\?token=\S+/.exec(
    (await mailTo(member, /^Je inloglink/)).text
  )![0];
  await page.goto(signin);
  await page.getByRole('button', { name: 'Inloggen' }).click();

  // A member reads the whole article.
  await page.goto(`${SITE}${article}`);
  await expect(page.getByText('LEDEN-BODY voor leden.')).toBeVisible();
  await expect(page.locator('.reader-gate')).toHaveCount(0);

  // Cancelling on their own page stops it at the end of the paid period.
  await page.goto(`${SITE}/my-giving`);
  const membership = page.getByRole('region', { name: /Lidmaatschap Vrienden .*€\s?5 per maand/ });
  await expect(membership).toContainText('Loopt');
  await expect(membership.getByRole('button', { name: 'Pauzeren' })).toHaveCount(0);
  await gate(page, 'own membership');
  await membership.getByText(/^Opzeggen per /).click();
  await membership.getByRole('button', { name: /^Zeg op per / }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Je lidmaatschap is opgezegd. Je blijft lid tot het eind van de betaalde periode.'
  );
  await expect(membership).toContainText('Opgezegd');
  await expect(membership).toContainText('Lid tot');

  // The charge run at the end of the period ends it without charging; the article stays open
  // through the grace, which ends 14 days after the paid period.
  const supporter = await withInvoker((invoker) =>
    invoker.run(useCases.getSupporter, principal, { email: member })
  );
  const [sub] = (
    await withInvoker((invoker) =>
      invoker.run(useCases.listSubscriptions, principal, { supporterId: supporter.id })
    )
  ).subscriptions;
  expect(sub).toMatchObject({ kind: 'membership', tierId: tier.id, cancelAtPeriodEnd: true });
  const end = new Date(sub!.paidThrough!);
  const ran = await withInvoker(
    (_invoker, uow) =>
      chargeSubscription(uow, systemPrincipal(principal.tenantId, 'subscriptions.charge'), sub!.id),
    { clock: { now: () => end } }
  );
  expect(ran).toBe('cancelled');
  const after = await withInvoker((invoker) =>
    invoker.run(useCases.getSupporter, principal, { email: member })
  );
  expect(after.grants).toContainEqual(
    expect.objectContaining({
      tierId: tier.id,
      kind: 'paid',
      until: new Date(end.getTime() + 14 * DAY).toISOString(),
    })
  );
  await page.goto(`${SITE}${article}`);
  await expect(page.getByText('LEDEN-BODY voor leden.')).toBeVisible();

  // The admin: the tier lists its member, Recurring filters memberships and names the tier.
  await login(page, `/admin/probe/access/${tier.id}`);
  const members = page.getByRole('region', { name: 'Leden' });
  await expect(members.getByRole('row').filter({ hasText: member })).toContainText(
    /€\s?5 per maand/
  );
  await gate(page, 'tier members');
  await page.goto('/admin/probe/donations/recurring?kind=membership');
  await expect(page.getByRole('row').filter({ hasText: member })).toContainText(
    `Lidmaatschap: ${tier.name.nl}`
  );
}
