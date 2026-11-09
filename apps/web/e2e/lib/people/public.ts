// One reading task crosses profiles, bylines and discovery; core/DB suites cover the data matrix.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { withInvoker, tenantId } from '../invoker';
import { isA11y, OTHER_SCRIPTS } from '../project';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';

export async function exercisePublicPeople(page: Page) {
  for (const locale of ['nl', 'en']) {
    const path = `/probe/${locale === 'en' ? 'en/' : ''}people/e2e-auteur`;
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveText('Sam de Vries');
    await expect(page.locator('main img')).toHaveCount(2);
    const body = await response!.text();
    expect(body).not.toMatch(/(?<!public-)sam@probe\.test/);
    expect(body).toContain('public-sam@probe.test');
    expect(response?.headers()['cache-control']).toContain('public');
    expect(response?.headers().vary ?? '').not.toContain('accept-language');
    expect(await page.locator(OTHER_SCRIPTS).count()).toBe(0);
    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').innerHTML());
    expect(schema['@type']).toBe('Person');
    expect(schema.email).toBe('public-sam@probe.test');
    const revalidation = await page.request.get(path, {
      headers: { 'if-none-match': response!.headers().etag! },
    });
    expect(revalidation.status()).toBe(304);
    const sitemap = await (await page.request.get('/probe/sitemap.xml')).text();
    expect(sitemap).toContain(`/people/e2e-auteur`);
    expect(sitemap).toContain('/en/people/e2e-auteur');
    expect(sitemap).not.toContain('@probe.test');
    if (isA11y()) {
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, `profile-${locale}-320-200`, 'main');
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: test.info().outputPath(`profile-${locale}-320-200.png`),
        fullPage: true,
      });
      for (const img of await page.locator('main img').all()) {
        await img.scrollIntoViewIfNeeded();
        const currentSrc = await img.evaluate((node: HTMLImageElement) => node.currentSrc);
        const asset = await page.request.get(currentSrc);
        expect(asset.headers()['content-type']).toMatch(/image\/(avif|webp)/);
        expect((await asset.body()).byteLength).toBeLessThanOrEqual(60_000);
        await expect
          .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
          .toBeGreaterThan(0);
        expect(await img.getAttribute('src')).toMatch(/\/w\d+\.webp$/);
        await expect(img).toHaveAttribute('width', /\d+/);
        await expect(img).toHaveAttribute('height', /\d+/);
      }
      await setTextSize(page, '100%');
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }
  const id = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const person = await invoker.run(useCases.createPerson, principal, {
      slug: `hostile-${id}`,
      name: '</script><img src=x onerror=alert(1)>',
      pagePolicy: 'always',
      email: `secret-${id}@private.test`,
      bio: { nl: 'Alleen profiel', en: 'Profile only' },
    });
    const path = `/probe/people/${person.slug}`;
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(await response!.text()).not.toContain(person.email);
    expect(await page.locator('main img').count()).toBe(0);
    expect(await page.locator('main section').count()).toBe(0);
    expect(
      JSON.parse(await page.locator('script[type="application/ld+json"]').innerHTML()).name
    ).toBe(person.name);
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    for (let index = 0; index < 19; index++) {
      const created = await invoker.run(useCases.createItem, principal, {
        slug: `profile-${id}-${index}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: `Profile article ${index}` },
          authorIds: [person.id],
          blocks: [],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: created.item.id,
        revisionId: created.revision.id,
        locale: 'nl',
      });
    }
    await page.goto(`${path}?offset=9`);
    await expect(page.locator('main article')).toHaveCount(9);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\?offset=9$/);
    await expect(page.locator('link[hreflang]')).toHaveCount(0);
    await expect(page.locator('.person-pagination a')).toHaveCount(2);
    if (isA11y()) {
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, 'profile-pagination-320-200', 'main');
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: test.info().outputPath('profile-pagination-320-200.png'),
        fullPage: true,
      });
      await setTextSize(page, '100%');
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    for (const offset of ['1', '-1', '27', '1000000'])
      expect((await page.request.get(`${path}?offset=${offset}`)).status()).toBe(404);
    await invoker.run(useCases.updatePerson, principal, {
      personId: person.id,
      baseUpdatedAt: person.updatedAt,
      name: person.name,
      pagePolicy: 'never',
    });
    const hidden = await page.request.get(path);
    const unknown = await page.request.get(`/probe/people/missing-${id}`);
    expect(hidden.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(hidden.headers()['cache-control']).toBe('no-store');
    const sitemap = await (await page.request.get('/probe/sitemap.xml')).text();
    expect(sitemap).not.toContain(person.slug);
    expect((await page.request.get('/probe/nl/people/e2e-auteur')).status()).toBe(404);
  });
  await page.goto('/probe/articles/bomen-in-de-straat');
  await expect(page.locator('.page-meta a')).toHaveAttribute('href', '/probe/people/e2e-auteur');
  await page.locator('.page-meta a').click();
  await expect(page.locator('h1')).toHaveText('Sam de Vries');
}
