// An agenda: an editor sets an overview block to past events in the block form, without
// JavaScript, beside one that lists the upcoming ones, and a visitor sees each event on the side
// of now it belongs to, soonest first, with when and where on the card, between the paragraphs
// around it. Which events a list holds around the turn is proven over both adapters in
// packages/db/src/content/overview-rule.ts; this task proves the form and the public page.
// Rejected: a spec of its own (the e2e budget) and asserting the whole list, which other runs on
// the shared probe site add to.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { BLOCK_DEFINITIONS, systemPrincipal, useCases, wallClock } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

const prose = (text: string) => ({
  type: 'rich-text' as const,
  version: BLOCK_DEFINITIONS['rich-text'].version,
  props: {
    content: {
      nl: {
        type: 'doc' as const,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    },
  },
});

async function narrow(page: Page, name: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, name, 'main');
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function exerciseAgenda(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const zone = (await invoker.run(useCases.getSiteGeneral, principal, {})).value.timeZone;
    const at = (hours: number) => wallClock(new Date(Date.now() + hours * 3_600_000), zone);
    const event = async (name: string, startsAt: string, endsAt?: string) => {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: `${name.toLowerCase()}-${suffix}`,
        document: {
          type: 'page',
          profile: 'event',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: `${name} ${suffix}` },
          event: { startsAt, ...(endsAt ? { endsAt } : {}), location: { nl: 'Buurthuis' } },
          blocks: [],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
    };
    const soon = at(2);
    await event('Morgen', at(26));
    await event('Straks', soon, at(4));
    await event('Afgelopen', at(-3), at(-2));

    const created = await invoker.run(useCases.createItem, principal, {
      slug: `agenda-${suffix}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Agenda' },
        blocks: [
          prose('Kom langs bij een van onze bijeenkomsten.'),
          { type: 'overview', version: 1, props: { source: 'event', limit: '24' } },
          { type: 'overview', version: 1, props: { limit: '24', layout: 'list' } },
          prose('Zelf iets organiseren? Laat het ons weten.'),
        ],
      },
    });
    const pastId = created.revision.document.blocks[2]!.id;

    // The editor, without a script in no-js: from articles to events, past ones.
    await login(page, `/admin/probe/content/${created.item.id}?block=${pastId}`);
    await editorReady(page);
    const prefix = `b.${pastId}.p.`;
    await page.locator(`[name="${prefix}source"]`).selectOption('event');
    await page.locator(`[name="${prefix}when"]`).selectOption('past');
    await reloadsEditor(page, () =>
      page.getByRole('button', { name: 'Save', exact: true }).click()
    );
    const saved = await invoker.run(useCases.getItem, principal, { itemId: created.item.id });
    expect(saved.revision.document.blocks[2]?.props).toMatchObject({
      source: 'event',
      when: 'past',
      layout: 'list',
    });
    await invoker.run(useCases.publishItem, principal, {
      itemId: created.item.id,
      revisionId: saved.revision.id,
      locale: 'nl',
    });

    // The visitor: upcoming soonest first with when and where, the ended one only under past.
    expect((await page.goto(`/probe/agenda-${suffix}`))?.status()).toBe(200);
    const [upcoming, past] = [
      page.locator(`#block-${created.revision.document.blocks[1]!.id}`),
      page.locator(`#block-${pastId}`),
    ];
    const mine = (list: typeof upcoming) =>
      list.locator('.overview-item').filter({ hasText: suffix });
    await expect(mine(upcoming).locator('a')).toHaveText([`Straks ${suffix}`, `Morgen ${suffix}`]);
    await expect(mine(upcoming).first().locator('time')).toHaveAttribute('datetime', soon);
    await expect(mine(upcoming).first()).toContainText('Buurthuis');
    await expect(mine(past).locator('a')).toHaveText([`Afgelopen ${suffix}`]);
    await expect(page.locator('main')).toContainText('Kom langs bij een van onze bijeenkomsten.');
    await expect(page.locator('main')).toContainText('Zelf iets organiseren? Laat het ons weten.');
    await narrow(page, 'agenda-public-320-200');
  });
}
