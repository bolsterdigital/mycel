// Status page (TODO #17c): a tenant administrator sees a stuck task of the site, tries it again,
// closes another after confirming, and reads a diagnosis without an address in it. Runs without
// JavaScript and under axe like the other admin specs; the UI gate (skill ui-action-layout) checks
// both action groups (a task's two buttons, the close confirmation) at 320 CSS px and 200% text.
//
// The stuck tasks go in as the worker leaves them (mycel_worker on the operator connection), with
// a type no handler knows and a run time a day ahead, so the e2e worker never takes them first.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Kysely } from 'kysely';
import type { Database } from '@mycel/db';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
}

/** As mycel_worker, the queue's own role: insert stuck jobs for tenant probe, or finish jobs. */
async function asWorker(fn: (trx: Kysely<Database>, probeId: string) => Promise<void>) {
  const { createDb, createTenantDirectory } = await import('@mycel/db');
  const { sql } = await import('kysely');
  const db = createDb(process.env['DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(db).findBySlug('probe');
    await db.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await fn(trx, probe!.id);
    });
  } finally {
    await db.destroy();
  }
}

/** A stuck job of tenant probe; its type names the test, so each test finds only its own. */
async function stuckJob(type: string): Promise<string> {
  const { uuidv7 } = await import('@mycel/db');
  const id = uuidv7();
  await asWorker(async (trx, probeId) => {
    await trx
      .insertInto('jobs')
      .values({
        id,
        tenant_id: probeId,
        type,
        key: `${type}:${id}`,
        run_at: new Date(Date.now() + 86_400_000),
        payload: JSON.stringify({ secret: 'e2e-payload' }),
        attempts: 10,
        max_attempts: 10,
        last_error: 'delivery failed for e2e-person@example.org',
      })
      .execute();
  });
  return id;
}

async function finish(ids: string[]) {
  await asWorker(async (trx) => {
    await trx
      .updateTable('jobs')
      .set({ done_at: new Date() })
      .where('id', 'in', ids)
      .where('done_at', 'is', null)
      .execute();
  });
}

const card = (page: Page, type: string) =>
  page.locator('article', { has: page.getByRole('heading', { level: 3, name: type }) });

test('an administrator retries and closes a stuck task without JavaScript', async ({ page }) => {
  const run = `${test.info().project.name}-${Date.now()}`;
  const retried = `e2e.status.${run}.retry`;
  const closed = `e2e.status.${run}.close`;
  const ids = [await stuckJob(retried), await stuckJob(closed)];
  try {
    await login(page, 'e2e-admin@probe.test', '/admin/probe');
    await page.getByRole('link', { name: 'Status en vastgelopen werk' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
    await expect(card(page, retried)).toContainText('10 van 10');
    await expect(card(page, retried)).toContainText('delivery failed for [email]');
    await expect(page.locator('main')).not.toContainText('e2e-payload');
    await expectNoAxeViolations(page);

    // The diagnosis is on the page, redacted, before anyone shares it.
    const diagnosis = page.locator('pre.diagnosis');
    await expect(diagnosis).toContainText('site: probe');
    await expect(diagnosis).toContainText(`- ${retried} `);
    await expect(diagnosis).not.toContainText('@');
    await expect(page.getByLabel('Diagnose, om te selecteren en kopiëren')).toHaveValue(
      /site: probe/
    );

    await card(page, retried).getByRole('button', { name: 'Opnieuw proberen' }).click();
    await expect(page.getByRole('status')).toContainText('De taak draait opnieuw');
    await expect(card(page, retried)).toHaveCount(0);

    // Closing asks first; the confirmation is a form of its own, so it works without JS too.
    await card(page, closed).getByRole('button', { name: 'Afsluiten' }).click();
    await expect(page.getByRole('heading', { name: `${closed} afsluiten?` })).toBeVisible();
    await expect(card(page, closed)).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Ja, sluit deze taak af' }).click();
    await expect(page.getByRole('status')).toContainText('De taak is afgesloten.');
    await expect(card(page, closed)).toHaveCount(0);

    // Both recoveries are in the latest actions.
    const actions = page.getByRole('region', { name: 'Laatste acties' });
    await expect(actions).toContainText('ops.job.close');
    await expect(actions).toContainText('ops.job.retry');
  } finally {
    await finish(ids);
  }
});

test.describe('UI gate: the status action groups at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const text of ['100%', '200%']) {
    test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
      const type = `e2e.status.gate.${text.replace('%', '')}.${Date.now()}`;
      const id = await stuckJob(type);
      try {
        await login(page, 'e2e-admin@probe.test', '/admin/probe/status');
        const measure = async (name: string, shot: Locator) => {
          if (text !== '100%') await page.addStyleTag({ content: `html { font-size: ${text}; }` });
          const problems = await page.evaluate(() => {
            const out: string[] = [];
            const width = document.documentElement.clientWidth;
            if (document.documentElement.scrollWidth > width)
              out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
            for (const b of document.querySelectorAll('main button, main a.button')) {
              const r = b.getBoundingClientRect();
              const label = b.textContent?.trim() ?? '';
              if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
              if (r.right > width + 1 || r.left < -1) out.push(`outside the viewport: ${label}`);
              if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
            }
            return out;
          });
          await shot.screenshot({
            path: test.info().outputPath(`status-${name}-320-${text.replace('%', '')}.png`),
          });
          expect(problems).toEqual([]);
        };
        await measure('job', card(page, type));
        await card(page, type).getByRole('button', { name: 'Afsluiten' }).click();
        await measure('confirm', page.locator('form[action="?/close"]'));
        await page.getByRole('link', { name: 'Laten staan' }).click();
        await expect(card(page, type)).toBeVisible();
      } finally {
        await finish([id]);
      }
    });
  }
});
