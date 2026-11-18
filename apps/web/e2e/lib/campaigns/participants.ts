// Who took part in a campaign (TODO MY-256 PR 2): the panel on the landing page links to the
// list, the list names the signers newest first with the withdrawn one said in words, and an
// administrator downloads them as CSV, a plain form post, so both projects walk it. An editor
// reads the list and gets neither the button nor the file; an author, who reads no supporters,
// gets neither the link nor the list. Core (`campaigns/participants.test.ts`) and the adapter
// rules prove the order, the totals and the file's cells; this proves the screens hand them over.
// The fixture is this flow's own campaign, so the counts do not depend on another test.
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { SupporterEvent, ingest, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

export async function exerciseCampaignParticipants(page: Page, editor: string, author: string) {
  const stamp = Date.now().toString(36);
  const emails = [`eerst-${stamp}@deelname.example`, `later-${stamp}@deelname.example`] as const;
  const { campaignId, landingId } = await withInvoker(async (invoker, uow) => {
    const principal = systemPrincipal(await tenantId(), 'e2e');
    const campaign = await invoker.run(useCases.composeCampaign, principal, {
      kind: 'petition',
      title: { nl: `Deelnamepetitie ${stamp}`, en: `Participation petition ${stamp}` },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      slug: `participation-${stamp}`,
    });
    for (const [i, email] of emails.entries()) {
      const ref = crypto.randomUUID();
      await uow.run(principal, (ctx) =>
        ingest(
          ctx,
          SupporterEvent.parse({
            schema: 'wings.supporter-event.v1',
            id: `participants-${ref}`,
            type: 'petition.signed',
            email,
            occurred_at: new Date(Date.UTC(2026, 10, 18, 9, i)).toISOString(),
            source: 'mycel',
            source_site: 'urn:mycel:e2e',
            source_ref: `submission:${ref}`,
            props: { campaign_id: campaign.id },
          })
        )
      );
    }
    const first = await invoker.run(useCases.getSupporter, principal, { email: emails[0] });
    await invoker.run(useCases.withdrawParticipation, principal, {
      campaignId: campaign.id,
      supporterId: first.id,
    });
    return { campaignId: campaign.id, landingId: campaign.landingItemId };
  });
  const list = `/admin/probe/campaigns/${campaignId}/participants`;

  await page.setViewportSize(NARROW);
  await login(page, `/admin/probe/content/${landingId}`);
  await expect(page.locator('#campaign a', { hasText: 'View participants' })).toHaveAttribute(
    'href',
    list
  );
  await page.goto(list);
  await expect(page.getByRole('heading', { level: 1, name: 'Participants' })).toBeVisible();
  const rows = page.locator('#participants tbody tr');
  await expect(rows.locator('th')).toHaveText([emails[1], emails[0]]);
  await expect(rows.nth(0)).toContainText('Counts');
  await expect(rows.nth(1).locator('.ui-badge')).toHaveText('Withdrawn');
  await expect(page.locator('.participants-count')).toHaveText('1 participant, 1 withdrawn');
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'campaign participants' });
    for (const text of TEXT_SIZES) {
      await setTextSize(page, text);
      await layoutGate(page, `campaign participants at ${text}`, 'main');
    }
    await setTextSize(page, '100%');
  }
  const button = page.getByRole('button', { name: 'Export as CSV', exact: true });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toMatch(
    /^participants-probe-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.csv$/
  );
  const text = await readFile(await download.path(), 'utf8');
  const lines = text.replace(/^﻿/, '').split('\r\n');
  expect(lines[0]).toBe('email,confirmed_at,withdrawn_at,supporter_id');
  expect(lines.slice(1, -1).map((l) => l.split(',')[0])).toEqual([emails[1], emails[0]]);
  expect(lines[2]?.split(',')[2]).toMatch(/^\d{4}-/);

  // An editor reads supporters but takes none out: the list, no button, and the post is refused.
  await page.context().clearCookies();
  await login(page, list, editor);
  await expect(rows).toHaveCount(2);
  await expect(button).toHaveCount(0);
  const refused = await page.request.post(`${list}/export`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(refused.status()).toBe(403);

  // An author writes the campaign's page and reads no supporters: no link, no list.
  await page.context().clearCookies();
  await login(page, `/admin/probe/content/${landingId}`, author);
  await expect(page.locator('#campaign')).toHaveCount(1);
  await expect(page.locator('#campaign a', { hasText: 'View participants' })).toHaveCount(0);
  expect((await page.goto(list))?.status()).toBe(403);
  await expect(page.getByText('deelname.example')).toHaveCount(0);
}
