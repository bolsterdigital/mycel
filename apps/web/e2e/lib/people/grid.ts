// A visitor sees exactly the authored team, with the same policy in both languages. The generic
// block suite covers all column variants; this task proves real references, links and contacts.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { withInvoker, tenantId } from '../invoker';
import { isA11y } from '../project';
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
    const group = await invoker.run(useCases.createPersonGroup, principal, {
      name: { nl: 'Bestuur', en: 'Board' },
      personIds: [person.id],
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
      const card = page.locator('.person-card');
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
    await expect(page.locator('.person-card h2 a')).toHaveAttribute(
      'href',
      `/probe/en/people/${person.slug}`
    );
  });
}
