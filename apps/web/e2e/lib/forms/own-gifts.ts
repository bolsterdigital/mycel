// The giver manages a monthly gift with a link (MY-254 PR 3), against the fake payment provider
// of the e2e runner: give monthly, ask for a link on `/my-giving`, open the link from the mail
// (the console mailer's spool), change the amount, pause, resume and stop, all with native forms
// (also in the no-js project); a forged and a tampered token give the same 404. Expired links,
// another site's link and another giver's gift are core records (`money/self-service.test.ts`,
// the subscription scenario of the adapter rules).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { pastMinimumFillTime } from '../form';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { forwarded } from '../login';
import { isA11y } from '../project';
import { give } from './donation';
import { monthlyPage } from './recurring';

/** The newest spooled mail to `to` whose subject matches (scripts/e2e/e2e.mjs sets the dir). */
async function mailTo(to: string, subject: RegExp): Promise<{ text: string; subject: string }> {
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

const linkIn = (text: string): string => /https?:\/\/\S+\/my-giving\/\S+/.exec(text)![0];

async function gate(page: Page, label: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label });
  await page.setViewportSize(NARROW);
  for (const size of ['200%', '16px']) {
    await setTextSize(page, size);
    await layoutGate(page, `${label} at 320px / ${size}`, 'main');
    if (size === '200%')
      await page.locator('main').screenshot({
        path: test.info().outputPath(`${label.replaceAll(' ', '-')}-320-200.png`),
      });
  }
}

export async function exerciseOwnGifts(page: Page, project: string): Promise<void> {
  const slug = await monthlyPage(`eigen-${project}`);
  const giver = `eigen-${project}-${Date.now()}@example.org`;
  await give(page, slug, giver, { preset: /10/, interval: 'Maandelijks' }, 'Betaald');
  await expect(page.getByText(/link waarmee je je gift kunt wijzigen/)).toBeVisible();
  // The start mail already carries a link; the page that asks for one is tested on its own.
  expect(linkIn((await mailTo(giver, /^Bedankt voor je gift/)).text)).toContain('?lang=nl');

  await page.context().setExtraHTTPHeaders(forwarded());
  await page.goto('/probe/my-giving');
  await expect(page.getByRole('heading', { level: 1, name: 'Mijn giften' })).toBeVisible();
  await gate(page, 'own gifts request form');
  await page.getByLabel('E-mailadres').fill(giver);
  await pastMinimumFillTime(page);
  await page.getByRole('button', { name: 'Stuur mij een link' }).click();
  await expect(page.getByRole('status')).toContainText('Geef je bij ons met dit adres');

  const link = linkIn((await mailTo(giver, /^Beheer je gift/)).text);
  // The mail names the site's primary hostname (`probe.localhost` in the runner), not the path.
  await page.goto(link);
  const gift = page.getByRole('region', { name: /€\s?10 per maand/ });
  await expect(gift).toContainText('Loopt');
  await gate(page, 'own gifts');

  await gift.getByLabel('Nieuw bedrag in euro').fill('12,50');
  await gift.getByRole('button', { name: 'Bedrag wijzigen' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Het nieuwe bedrag geldt vanaf de volgende afschrijving.'
  );
  const changed = page.getByRole('region', { name: /€\s?12,50 per maand/ });
  await changed.getByRole('button', { name: 'Pauzeren' }).click();
  await expect(page.getByRole('status')).toHaveText('Je gift is gepauzeerd.');
  await expect(changed).toContainText('Gepauzeerd');
  await changed.getByRole('button', { name: 'Hervatten' }).click();
  await expect(page.getByRole('status')).toHaveText('Je gift loopt weer.');

  await changed.getByText('Gift stoppen').click();
  await changed.getByRole('button', { name: 'Ja, stop mijn gift' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Je gift is gestopt. Er wordt niets meer afgeschreven.'
  );
  await expect(changed).toContainText('Gestopt');
  await expect(changed.getByRole('button')).toHaveCount(0);

  // A forged token and a real one with one character changed: the same 404 as any unknown page.
  const { origin, pathname } = new URL(link);
  const token = decodeURIComponent(pathname.split('/my-giving/')[1]!);
  const tampered = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.at(-1);
  for (const bad of ['forged', tampered]) {
    const res = await page.request.get(`${origin}/my-giving/${encodeURIComponent(bad)}`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain('Mijn giften');
  }
}
