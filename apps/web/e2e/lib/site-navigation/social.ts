// A site's social profiles (MY-273), from the site screen to the footer. A fresh site shows no
// "Volg ons" column; an editor fills four profiles and an e-mail address on the site screen, and
// the footer then shows one icon link per profile, named "<site> op Bluesky" and "Mail <site>",
// each a 44 px target, on one row beside footer text and two menu columns at 1280 px (as Frisse
// Wind's four icons; a fixed column basis wrapped the fourth), at 320 px and 200% text
// without horizontal scroll, axe clean. Core covers
// which URLs a write refuses; this proves the form and what a visitor gets.
// Rejected: a spec of its own (the e2e budget) and the shared probe site, whose footer other
// tests and the quality corpus read.
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

export async function exerciseSiteSocial(page: Page) {
  const slug = `social-${randomBytes(4).toString('hex')}`;
  const editor = `site-editor-${slug}@probe.test`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, { name: 'Otters', platformDomain: process.env['PLATFORM_DOMAIN']! })
  );
  await withInvoker((invoker) =>
    invoker.run(useCases.inviteMember, systemPrincipal(tenant.id, 'e2e'), {
      email: editor,
      capabilities: ['content:write', 'content:read'],
    })
  );
  // Footer text and two placed menu columns, so the profiles share the row as on a real site.
  await withInvoker(async (invoker) => {
    const owner = systemPrincipal(tenant.id, 'e2e');
    const chrome = await invoker.run(useCases.getSiteChrome, owner, {});
    await invoker.run(useCases.updateSiteChrome, owner, {
      baseVersion: chrome.version,
      chrome: { footer: { nl: 'Stichting Otters, voor de otters van de delta.' } },
    });
    const link = (id: string, nl: string) => ({
      id,
      kind: 'link' as const,
      label: { nl },
      target: { kind: 'system' as const, page: 'search' as const },
    });
    const menu = (id: string) => ({
      id,
      name: id,
      nodes: [link(`${id}-1`, 'Algemene voorwaarden')],
    });
    const saved = await invoker.run(useCases.updateNavigation, owner, {
      baseRevisionId: null,
      document: {
        menus: [menu('info'), menu('doe-mee')],
        placements: {
          main: null,
          actions: null,
          footer: [
            { menuId: 'info', title: { nl: 'Info' } },
            { menuId: 'doe-mee', title: { nl: 'Doe mee' } },
          ],
          legal: null,
        },
      },
    });
    await invoker.run(useCases.publishNavigation, owner, {
      revisionId: saved.revisionId!,
      locale: 'nl',
    });
  });
  const footer = page.getByRole('contentinfo');
  await page.goto(`/${slug}/search`);
  await expect(footer).toBeVisible();
  await expect(footer.getByRole('heading', { name: 'Volg ons' })).toHaveCount(0);

  await login(page, `/admin/${slug}/site?section=chrome`, editor);
  const form = page.locator('form[action$="&/social"]');
  await form.getByLabel('Bluesky').fill('https://bsky.app/profile/otters.example');
  await form.getByLabel('Instagram').fill('https://www.instagram.com/otters');
  await form.getByLabel('LinkedIn').fill('https://www.linkedin.com/company/otters');
  await form.getByLabel('YouTube').fill('https://www.youtube.com/@otters');
  // The admin speaks the browser's language (English here), the site its own (Dutch).
  const email = form.getByLabel(/^(E-mailadres|Email address)$/);
  await email.fill('info@otters.example');
  await form.getByRole('button', { name: /^(Sociale media opslaan|Save social media)$/ }).click();
  await expect(page.locator('[role="status"]')).toBeVisible();
  await expect(email).toHaveValue('info@otters.example');
  const state = await withInvoker((invoker) =>
    invoker.run(useCases.getSiteChrome, systemPrincipal(tenant.id, 'e2e'), {})
  );
  expect(state.value.social).toEqual({
    bluesky: 'https://bsky.app/profile/otters.example',
    instagram: 'https://www.instagram.com/otters',
    linkedin: 'https://www.linkedin.com/company/otters',
    youtube: 'https://www.youtube.com/@otters',
    email: 'mailto:info@otters.example',
  });

  await page.goto(`/${slug}/search`);
  // Inside the public freshness window a navigation may reuse the old HTML; reload revalidates.
  await page.reload();
  await expect(footer.getByRole('heading', { name: 'Volg ons' })).toBeVisible();
  const links = footer.locator('.site-social').getByRole('link');
  await expect(links).toHaveText([
    'Otters op Bluesky',
    'Otters op Instagram',
    'Otters op LinkedIn',
    'Otters op YouTube',
    'Mail Otters',
  ]);
  await expect(links.first()).toHaveAttribute('href', 'https://bsky.app/profile/otters.example');
  await expect(links.last()).toHaveAttribute('href', 'mailto:info@otters.example');
  const boxes = await links.evaluateAll((all) =>
    all.map((a) => a.getBoundingClientRect().toJSON())
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    new Set(boxes.map((b) => Math.round(b.top))).size,
    'five profiles on one row beside text and two columns at 1280 px'
  ).toBe(1);
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label: 'footer with social profiles' });
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'footer with social profiles at 320 px and 200% text', '.site-footer');
}
