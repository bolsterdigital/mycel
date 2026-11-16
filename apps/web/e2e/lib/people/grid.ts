// A visitor sees exactly the authored team, with the same policy in both languages. The generic
// block suite covers all column variants; this task proves real references, links and contacts,
// and a group that mixes a person with an organisation.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { withInvoker, tenantId } from '../invoker';
import { callApi } from '../api';
import { isA11y } from '../project';
import { login } from '../login';
import { editorReady, reloadsEditor } from '../editor';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';

export async function exercisePeopleGrid(page: Page) {
  const suffix = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const person = await invoker.run(useCases.createPerson, principal, {
      slug: `team-${suffix}`,
      name: 'Team member with a long name',
      email: `internal-${suffix}@private.test`,
      publicEmail: `contact-${suffix}@example.org`,
      bio: { nl: 'Een teamlid zonder artikelen.', en: 'A team member without articles.' },
      role: { nl: 'Bestuurslid', en: 'Board member' },
      links: [{ label: 'More about our work together', url: 'https://example.org/team' }],
    });
    // A mixed group: an organisation shows its logo whole and links to its website.
    // Through the API: the e2e invoker has no image processor.
    const logo = await callApi(page.request, 'media.upload', {
      ...useCases.uploadMedia.examples[0]!.input,
      filename: `partner-${suffix}.png`,
    });
    const partner = await invoker.run(useCases.createPerson, principal, {
      slug: `partner-${suffix}`,
      kind: 'organisation',
      name: 'Partner foundation',
      imageId: logo.id,
      bio: { nl: 'Steunt buurtinitiatieven.', en: 'Supports local initiatives.' },
      links: [{ label: 'Website', url: 'https://partner.example/', kind: 'website' }],
    });
    const group = await invoker.run(useCases.createPersonGroup, principal, {
      name: { nl: 'Bestuur', en: 'Board' },
      personIds: [person.id, partner.id],
    });
    const created = await invoker.run(useCases.createItem, principal, {
      slug: `team-${suffix}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Ons team', en: 'Our team' },
        blocks: [
          {
            type: 'people-grid',
            version: 1,
            props: { source: 'group', groupId: group.id, showContact: true },
          },
        ],
      },
    });
    for (const locale of ['nl', 'en']) {
      await invoker.run(useCases.publishItem, principal, {
        itemId: created.item.id,
        revisionId: created.revision.id,
        locale,
      });
      const response = await page.goto(
        `/probe/${locale === 'en' ? 'en/' : ''}${created.item.slug}`
      );
      expect(response?.status()).toBe(200);
      const org = page.locator('.person-card-organisation');
      await expect(org.locator('h2 a')).toHaveAttribute('href', 'https://partner.example/');
      await expect(org.locator('h2')).toHaveText(partner.name);
      await expect(org.locator('img')).toHaveCSS('object-fit', 'contain');
      await expect(org).toContainText(
        locale === 'nl' ? 'Steunt buurtinitiatieven.' : 'Supports local initiatives.'
      );
      expect((await page.request.get(`/probe/people/${partner.slug}`)).status()).toBe(404);
      const card = page.locator('.person-card:not(.person-card-organisation)');
      await expect(card).toHaveCount(1);
      await expect(card.locator('h2')).toHaveText(person.name);
      await expect(card.locator('h2 a')).toHaveCount(0);
      await expect(card.locator('img')).toHaveCount(0);
      await expect(card).toContainText(locale === 'nl' ? 'Bestuurslid' : 'Board member');
      await expect(card.locator('a[href^="mailto:"]')).toHaveText(person.publicEmail!);
      expect(await response!.text()).not.toContain(person.email);
      expect((await page.request.get(`/probe/people/${person.slug}`)).status()).toBe(404);
      if (isA11y()) {
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await layoutGate(page, `people-grid-${locale}-320-200`, 'main');
        await expectNoAxeViolations(page);
        await page.screenshot({
          path: test.info().outputPath(`people-grid-${locale}-320-200.png`),
          fullPage: true,
        });
        await setTextSize(page, '100%');
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }
    await invoker.run(useCases.updatePerson, principal, {
      personId: person.id,
      baseUpdatedAt: person.updatedAt,
      name: person.name,
      pagePolicy: 'always',
    });
    await page.reload();
    await expect(page.locator('.person-card:not(.person-card-organisation) h2 a')).toHaveAttribute(
      'href',
      `/probe/en/people/${person.slug}`
    );
    const blockId = created.revision.document.blocks[0]!.id;
    await login(page, `/admin/probe/content/${created.item.id}?block=${blockId}`);
    await editorReady(page);
    const prefix = `b.${blockId}.p.`;
    await page.locator(`[name="${prefix}source"]`).selectOption('selection');
    await page.locator(`[name="${prefix}groupId"]`).selectOption('');
    await page.locator(`[name="${prefix}people.0.personId"]`).selectOption(person.id);
    await page
      .locator(`#block-${blockId} summary`)
      .filter({ hasText: /^Display$/ })
      .click();
    await page.locator(`[name="${prefix}columns"]`).selectOption('4');
    await reloadsEditor(page, () =>
      page.getByRole('button', { name: 'Save', exact: true }).click()
    );
    const saved = await invoker.run(useCases.getItem, principal, { itemId: created.item.id });
    expect(saved.revision.document.blocks[0]?.props).toMatchObject({
      source: 'selection',
      groupId: null,
      people: [{ personId: person.id }],
      columns: '4',
    });
    if (isA11y()) {
      await page.goto(`/admin/probe/content/${created.item.id}?block=${blockId}`);
      await editorReady(page);
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, 'people-grid-editor-320-200', 'main');
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: test.info().outputPath('people-grid-editor-320-200.png'),
        fullPage: true,
      });
    }
  });
}
