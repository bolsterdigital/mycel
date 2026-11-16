// An editor turns a page into a news overview: the block's form picks a section by name and pins
// an article by title, without JavaScript, and a visitor sees the pin on top, the section's
// articles under it and a plain link to the older ones. The generic block suite renders every
// example; this task proves the editor's choices and the list the public page reads.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { BLOCK_DEFINITIONS, systemPrincipal, useCases } from '@mycel/core';
import { withInvoker, tenantId } from '../invoker';
import { isA11y } from '../project';
import { login } from '../login';
import { editorReady, reloadsEditor } from '../editor';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';

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
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, name, 'main');
  await expectNoAxeViolations(page);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function exerciseOverview(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const section = await invoker.run(useCases.createSection, principal, {
      slug: `buurt-${suffix}`,
      title: { nl: `Buurt ${suffix}` },
    });
    const article = async (slug: string, title: string, sectionId: string | null) => {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: `${slug}-${suffix}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: `${title} ${suffix}` },
          lead: { nl: `Kort over ${title.toLowerCase()}.` },
          ...(sectionId ? { sectionId } : {}),
          blocks: [],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      return item;
    };
    // Oldest first, so the newest is `derde`; `elders` is outside the section and gets pinned.
    const elders = await article('elders', 'Elders', null);
    for (const [slug, title] of [
      ['eerste', 'Eerste'],
      ['tweede', 'Tweede'],
      ['derde', 'Derde'],
    ] as const)
      await article(slug, title, section.id);
    const created = await invoker.run(useCases.createItem, principal, {
      slug: `nieuws-${suffix}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Nieuws' },
        blocks: [
          prose('Het laatste nieuws uit de buurt.'),
          { type: 'overview', version: 1, props: {} },
          prose('Meer lezen? Kijk in het archief.'),
        ],
      },
    });
    const blockId = created.revision.document.blocks[1]!.id;

    // The editor, without a script in no-js: section by name, pin by title, two per page, archive.
    await login(page, `/admin/probe/content/${created.item.id}?block=${blockId}`);
    await editorReady(page);
    const prefix = `b.${blockId}.p.`;
    await page.locator(`[name="${prefix}sectionId"]`).selectOption({ label: section.title.nl! });
    await page
      .locator(`[name="${prefix}pinned.0.itemId"]`)
      .selectOption({ label: `Elders ${suffix} (/elders-${suffix})` });
    await page.locator(`[name="${prefix}limit"]`).selectOption('3');
    await page.locator(`[name="${prefix}archive"]`).check();
    await reloadsEditor(page, () =>
      page.getByRole('button', { name: 'Save', exact: true }).click()
    );
    const saved = await invoker.run(useCases.getItem, principal, { itemId: created.item.id });
    expect(saved.revision.document.blocks[1]?.props).toMatchObject({
      sectionId: section.id,
      pinned: [{ itemId: elders.id }],
      limit: '3',
      archive: true,
    });
    if (isA11y()) {
      await page.goto(`/admin/probe/content/${created.item.id}?block=${blockId}`);
      await editorReady(page);
      await narrow(page, 'overview-editor-320-200');
    }

    // The visitor: the pin, then the two newest of the section; the oldest on page 2.
    await invoker.run(useCases.publishItem, principal, {
      itemId: created.item.id,
      revisionId: saved.revision.id,
      locale: 'nl',
    });
    expect((await page.goto(`/probe/nieuws-${suffix}`))?.status()).toBe(200);
    const titles = page.locator('.overview-item h2 a, .overview-item h3 a');
    await expect(titles).toHaveText([`Elders ${suffix}`, `Derde ${suffix}`, `Tweede ${suffix}`]);
    await expect(page.locator('main')).toContainText('Het laatste nieuws uit de buurt.');
    await expect(page.locator('main')).toContainText('Meer lezen? Kijk in het archief.');
    if (isA11y()) await narrow(page, 'overview-public-320-200');
    await page.locator('.overview-pages a').click();
    await expect(page).toHaveURL(new RegExp(`/probe/nieuws-${suffix}\\?p=2$`));
    await expect(titles).toHaveText([`Eerste ${suffix}`]);
    await expect(page.locator('.overview-pages a')).toHaveAttribute(
      'href',
      `/probe/nieuws-${suffix}`
    );
  });
}
