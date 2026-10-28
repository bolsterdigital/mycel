// Native consent and translation workflow against the built server and deterministic fake model.
// Rejected: mocking action responses, which would miss tenant and revision checks in the registry.
import { expect, test, type Page } from '@playwright/test';
import { ContentDocumentInput, systemPrincipal, useCases, type Principal } from '@mycel/core';
import { upsertTenant } from '@mycel/db';
import { closeTenantWork } from '@mycel/db/testing';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: { 'x-forwarded-proto': 'http', 'x-forwarded-for': '2001:db8:24a::1' },
});

const fixtureTenants = new Set<string>();
test.afterAll(() => asOwner((owner) => closeTenantWork(owner, [...fixtureTenants])));

const sites = new WeakMap<Page, { id: string; slug: string; email: string }>();
const base = (page: Page) => `/admin/${sites.get(page)!.slug}`;

/** A fresh site with one `tenant:admin`, signed in on its assistance settings. */
async function signInToFreshSite(page: Page) {
  const slug = `assist-${crypto.randomUUID().slice(0, 18)}`;
  const email = `${slug}@probe.test`;
  const tenant = await asOwner((owner) =>
    upsertTenant(
      owner,
      {
        id: crypto.randomUUID(),
        slug,
        name: 'Assistance fixture',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
      },
      { platformDomain: process.env['PLATFORM_DOMAIN']! }
    )
  );
  sites.set(page, { ...tenant, email });
  fixtureTenants.add(tenant.id);
  await withInvoker((invoker) =>
    invoker.run(useCases.inviteMember, systemPrincipal(tenant.id, 'e2e-assist-login'), {
      email,
      capabilities: ['tenant:admin'],
    })
  );
  await login(page, `${base(page)}/assist`, email);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
}

const FAKE_MODEL = { assistProviderLabel: 'Fake model' };

async function inSite<T>(
  page: Page,
  action: (
    invoker: Parameters<Parameters<typeof withInvoker>[0]>[0],
    principal: Principal
  ) => Promise<T>
) {
  return withInvoker(
    (invoker) => action(invoker, systemPrincipal(sites.get(page)!.id, 'e2e-assist-state')),
    FAKE_MODEL
  );
}

async function permissions(page: Page, capabilities: Principal['capabilities']) {
  await inSite(page, async (invoker, principal) => {
    const { members } = await invoker.run(useCases.listMembers, principal, {});
    const member = members.find((m) => m.email === sites.get(page)!.email)!;
    if (members.length === 1)
      await invoker.run(useCases.inviteMember, principal, {
        email: `steward-${sites.get(page)!.slug}@probe.test`,
        capabilities: ['tenant:admin'],
      });
    await invoker.run(useCases.updateMember, principal, {
      operatorId: member.operatorId,
      capabilities,
    });
  });
}

async function acceptWithKeyboard(page: Page) {
  const edit = new URL(page.url()).pathname.replace(/\/assist$/, '');
  await expectNoAxeViolations(page);
  await page.locator('#assist-value').focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: /Aangepaste waarde overnemen|Accept edited value/ })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${edit}?saved=1`);
}

async function enable(page: Page) {
  await page.goto(`${base(page)}/assist`);
  await page.getByLabel(/AI-hulp voor deze site aanzetten|Enable assistance for this site/).check();
  await page.getByLabel(/Ik stem in met het versturen|I consent to sending/).check();
  await page
    .getByRole('button', { name: /AI-instellingen opslaan|Save assistance settings/ })
    .click();
}

// Only the real process started by scripts/e2e.mjs completes jobs. Native refresh reads its
// result; there is no competing helper worker and alt must read the actual stored image bytes.
// Wait for that refresh instead of reloading in the test: competing navigations can detach
// Chromium's page, and a manual reload would not prove the no-JavaScript refresh works.
async function ready(page: Page) {
  await expect(page.locator('#assist-value')).toBeVisible();
}

async function imagePage(page: Page, project: string) {
  await page.goto(`${base(page)}/media`);
  const example = useCases.uploadMedia.examples[0]!.input;
  await page.getByLabel(/^(Bestanden \(verplicht\)|Files \(required\))$/).setInputFiles({
    name: 'assist.png',
    mimeType: 'image/png',
    buffer: Buffer.from(example.bytes, 'base64'),
  });
  await page.getByRole('button', { name: /^(Uploaden|Upload)$/, exact: true }).click();
  const src = await page.locator('article img').first().getAttribute('src');
  const mediaId = /media\/([0-9a-f-]{36})\/thumb/.exec(src ?? '')?.[1];
  expect(mediaId).toBeTruthy();
  const site = sites.get(page)!.id;
  const probe = await tenantId();
  return withInvoker(async (invoker) => {
    const principal = systemPrincipal(site, 'e2e-assist-image');
    const sourcePrincipal = systemPrincipal(probe, 'e2e-assist-source');
    const { items } = await invoker.run(useCases.listItems, sourcePrincipal, {
      type: 'page',
      slug: `e2e-blokken-${project}`,
    });
    if (!items[0]) throw new Error('seed image page missing');
    const { revision } = await invoker.run(useCases.getItem, sourcePrincipal, {
      itemId: items[0].id,
    });
    const image = revision.document.blocks.find((block) => block.type === 'image');
    if (!image) throw new Error('seed image missing');
    const { id: _sourceBlockId, ...imageInput } = image;
    const document = {
      ...revision.document,
      access: { level: 'public' },
      blocks: [{ ...imageInput, props: { ...imageInput.props, mediaId } }],
      machineTranslation: {},
    };
    const parsed = ContentDocumentInput.safeParse(document);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const created = await invoker.run(useCases.createItem, principal, {
      slug: `assist-alt-${project}-${Date.now()}`,
      document: parsed.data,
    });
    return {
      edit: `${base(page)}/content/${created.item.id}`,
      blockId: created.revision.document.blocks[0]!.id,
    };
  }, FAKE_MODEL);
}

for (const locale of ['nl-NL', 'en-GB']) {
  test.describe(locale, () => {
    test.use({ locale });
    test('missing and stale provider context requires fresh consent; disabling stays available', async ({
      page,
    }) => {
      await signInToFreshSite(page);
      const provider = page.locator('input[name="provider"]');
      await expect(provider).toHaveValue('Fake model');
      const before = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.getAssistSettings, principal, {})
      );
      for (const submitted of [undefined, '', 'Previously displayed processor']) {
        const response = await page.request.post(`${base(page)}/assist?/save`, {
          form: {
            enabled: 'on',
            consent: 'on',
            ...(submitted === undefined ? {} : { provider: submitted }),
          },
          headers: {
            origin: 'http://127.0.0.1:4173',
            accept: 'text/html',
            'accept-language': locale,
          },
        });
        expect(response.status()).toBe(400);
        const html = await response.text();
        expect(html).toContain(
          locale === 'nl-NL' ? 'De provider is gewijzigd' : 'The provider has changed'
        );
        expect(html).toContain('value="Fake model"');
        const consentInput = html.match(/<input[^>]*name="consent"[^>]*>/)?.[0];
        expect(consentInput).toBeTruthy();
        expect(consentInput).not.toContain('checked');
        expect(
          await inSite(page, (invoker, principal) =>
            invoker.run(useCases.getAssistSettings, principal, {})
          )
        ).toEqual(before);
      }
      await enable(page);
      await expect(page).toHaveURL(`${base(page)}/assist?saved=1`);
      expect(
        await inSite(page, (invoker, principal) =>
          invoker.run(useCases.getAssistSettings, principal, {})
        )
      ).toMatchObject({ enabled: true, consentedProvider: 'Fake model' });
      // Revocation never depends on a valid hidden label or a new consent checkbox.
      const disabled = await page.request.post(`${base(page)}/assist?/save`, {
        form: { provider: 'Old processor' },
        headers: {
          origin: 'http://127.0.0.1:4173',
          accept: 'text/html',
          'accept-language': locale,
        },
      });
      expect(disabled.status()).toBe(200);
      expect(
        await inSite(page, (invoker, principal) =>
          invoker.run(useCases.getAssistSettings, principal, {})
        )
      ).toMatchObject({ enabled: false, consentedProvider: null });
      await page.goto(`${base(page)}/assist`);
      await expectNoAxeViolations(page);
    });

    test('consent, pending translation, edited acceptance and human publication approval', async ({
      page,
    }) => {
      await signInToFreshSite(page);
      await expect(page.getByText(/De hoster staat hulp|The host permits/)).toBeVisible();
      await page
        .getByLabel(/AI-hulp voor deze site aanzetten|Enable assistance for this site/)
        .check();
      await page
        .getByRole('button', { name: /AI-instellingen opslaan|Save assistance settings/ })
        .click();
      await expect(page.getByRole('alert')).toContainText(
        /Expliciete toestemming|Explicit consent/
      );
      await expectNoAxeViolations(page);
      await page.getByLabel(/Ik stem in met het versturen|I consent to sending/).check();
      await page
        .getByRole('button', { name: /AI-instellingen opslaan|Save assistance settings/ })
        .click();
      await expect(page).toHaveURL(`${base(page)}/assist?saved=1`);

      await page.goto(`${base(page)}/content/new?type=page`);
      await page.getByLabel('Slug').fill(`assist-${test.info().project.name}-${Date.now()}`);
      await page.getByLabel(/^(Titel|Title) \(nl\) \((verplicht|required)\)$/).fill('Bronkop');
      await page.getByLabel(/^(Titel|Title) \(en\)$/).fill('English heading');
      await page.getByRole('button', { name: /Concept maken|Create draft/ }).click();
      const edit = new URL(page.url()).pathname;
      await page
        .getByRole('link', { name: /(Vertaal uit nl.*Titel|Translate from nl.*Title).*en/ })
        .click();
      await expect(page.getByText('Bronkop')).toBeVisible();
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      await expect(page.getByRole('status')).toContainText(/wordt gemaakt|being prepared/);
      const suggestionId = new URL(page.url()).searchParams.get('suggestion');
      expect(suggestionId).toMatch(/^[0-9a-f-]{36}$/);
      await ready(page);
      await expect(page.getByLabel(/Pas het voorstel aan|Edit the proposal/)).toHaveValue(
        '[en] Bronkop'
      );
      await page
        .getByRole('button', { name: /Opnieuw een suggestie vragen|Request a new suggestion/ })
        .click();
      expect(new URL(page.url()).searchParams.get('suggestion')).not.toBe(suggestionId);
      await ready(page);
      await page.getByRole('button', { name: /Suggestie negeren|Dismiss suggestion/ }).click();
      await expect(
        page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ })
      ).toBeVisible();
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      const retryId = new URL(page.url()).searchParams.get('suggestion');
      expect(retryId).not.toBe(suggestionId);
      await ready(page);
      await page
        .getByLabel(/Pas het voorstel aan|Edit the proposal/)
        .fill('Edited English heading');
      await acceptWithKeyboard(page);
      await expect(page).toHaveURL(`${edit}?saved=1`);
      const publication = page.locator('.publication', {
        has: page.locator('#publication-en'),
      });
      await expect(page.locator('details.block')).toHaveCount(0);
      await expect(publication).toContainText(/Machinevertaling|Machine translation/);
      await expect(publication.locator('a[href="#publication-en"]')).toHaveCount(1);
      await permissions(page, ['content:read', 'content:write', 'ai:assist']);
      await page.reload();
      await expect(publication).toContainText(/Machinevertaling|Machine translation/);
      await expect(publication.locator('.translation-approval')).toHaveCount(0);
      const denied = await page.request.post(`${edit}?/approveTranslation`, {
        form: {
          locale: 'en',
          baseRevisionId: await page.locator('input[name="baseRevisionId"]').first().inputValue(),
        },
        headers: { origin: 'http://127.0.0.1:4173' },
      });
      expect(denied.status()).toBe(403);
      await permissions(page, ['tenant:admin']);
      await page.reload();
      await page
        .locator('.publication', { has: page.locator('#publication-en') })
        .getByRole('button', { name: /Vertaling in en goedkeuren|Approve translation in en/ })
        .click();
      await expect(publication).not.toContainText(/Machinevertaling|Machine translation/);
      await expectNoAxeViolations(page);
    });

    test('disabled, forbidden and stale/conflicting requests preserve the current revision', async ({
      page,
    }) => {
      await signInToFreshSite(page);
      const created = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.createItem, principal, {
          slug: 'state-fixture',
          document: ContentDocumentInput.parse({
            type: 'page',
            defaultLocale: 'nl',
            locales: ['nl', 'en'],
            title: { nl: 'Bronkop', en: 'English heading' },
            blocks: [],
            access: { level: 'public' },
          }),
        })
      );
      const edit = `${base(page)}/content/${created.item.id}`;
      const route = `${edit}/assist?task=translate&from=nl&to=en&target=title`;
      await page.goto(edit);
      await expect(page.locator('a[href*="/assist?task="]')).toHaveCount(0);
      expect((await page.goto(route))!.status()).toBe(403);
      await enable(page);
      await page.goto(route);
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      await ready(page);
      const suggestionUrl = page.url();
      // A missing row and a valid proposal bound to another item are 404s, never server errors.
      expect((await page.request.get(`${route}&suggestion=${crypto.randomUUID()}`)).status()).toBe(
        404
      );
      const other = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.createItem, principal, {
          slug: 'other-item',
          document: created.revision.document,
        })
      );
      const foreignRoute = suggestionUrl.replace(created.item.id, other.item.id);
      expect((await page.request.get(foreignRoute)).status()).toBe(404);
      expect(
        (
          await page.request.post(`${foreignRoute}&/accept`, {
            form: {
              suggestionId: new URL(suggestionUrl).searchParams.get('suggestion')!,
              baseRevisionId: other.revision.id,
              value: 'Forged',
            },
            headers: { origin: 'http://127.0.0.1:4173' },
          })
        ).status()
      ).toBe(404);
      // Revoking tenant consent after a proposal is ready also closes its direct URL.
      await page.goto(`${base(page)}/assist`);
      await page
        .getByLabel(/AI-hulp voor deze site aanzetten|Enable assistance for this site/)
        .uncheck();
      await page
        .getByRole('button', { name: /AI-instellingen opslaan|Save assistance settings/ })
        .click();
      expect((await page.request.get(suggestionUrl)).status()).toBe(403);
      await enable(page);
      await page.goto(suggestionUrl);
      const updated = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.updateItem, principal, {
          itemId: created.item.id,
          baseRevisionId: created.revision.id,
          document: {
            ...created.revision.document,
            title: { nl: 'Nieuwe bron', en: 'English heading' },
          },
        })
      );
      const response = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('/assist')
      );
      await page
        .getByRole('button', { name: /Aangepaste waarde overnemen|Accept edited value/ })
        .click();
      expect((await response).status()).toBe(409);
      await expect(page.getByRole('alert').first()).toBeVisible();
      await expect(page.getByText('Nieuwe bron', { exact: true })).toBeVisible();
      await expect(page.locator('#assist-value')).toHaveCount(0);
      await page.goto(suggestionUrl);
      await expect(page.getByRole('alert')).toContainText(
        /De bron is gewijzigd|The source changed/
      );
      await expect(
        page.getByRole('button', { name: /Opnieuw een suggestie vragen|Request a new suggestion/ })
      ).toBeVisible();
      const current = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.getItem, principal, { itemId: created.item.id })
      );
      expect(current.revision.id).toBe(updated.revision.id);
      expect(current.item.publication.every((p) => !p.publishedRevisionId)).toBe(true);
      await permissions(page, ['content:read', 'content:write']);
      await page.goto(edit);
      await expect(page.locator('a[href*="/assist?task="]')).toHaveCount(0);
      expect((await page.goto(route))!.status()).toBe(403);
      expect(
        (
          await page.request.post(`${route}&/request`, {
            form: { baseRevisionId: current.revision.id },
            headers: { origin: 'http://127.0.0.1:4173' },
          })
        ).status()
      ).toBe(403);
    });

    test('locale approval survives removal of the translated block', async ({ page }) => {
      await signInToFreshSite(page);
      await enable(page);
      const created = await inSite(page, (invoker, principal) =>
        invoker.run(useCases.createItem, principal, {
          slug: 'removed-translation',
          document: ContentDocumentInput.parse({
            type: 'page',
            defaultLocale: 'nl',
            locales: ['nl', 'en'],
            title: { nl: 'Bronkop', en: 'English heading' },
            blocks: [
              { type: 'heading', version: 1, props: { text: { nl: 'Bron', en: 'Heading' } } },
            ],
            access: { level: 'public' },
          }),
        })
      );
      const blockId = created.revision.document.blocks[0]!.id;
      const edit = `${base(page)}/content/${created.item.id}`;
      await page.goto(
        `${edit}/assist?task=translate&from=nl&to=en&target=blocks.${blockId}.props.text`
      );
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      await ready(page);
      await acceptWithKeyboard(page);
      await inSite(page, async (invoker, principal) => {
        const current = await invoker.run(useCases.getItem, principal, { itemId: created.item.id });
        await invoker.run(useCases.removeBlock, principal, {
          itemId: current.item.id,
          baseRevisionId: current.revision.id,
          blockId,
        });
      });
      await page.reload();
      await expect(page.locator('details.block')).toHaveCount(0);
      const publication = page.locator('.publication', {
        has: page.locator('#publication-en'),
      });
      await expect(publication).toContainText(/Machinevertaling|Machine translation/);
      await expect(publication.locator('a[href="#publication-en"]')).toHaveCount(1);
      // Prove all approval controls in the same nl/en reflow and text cases as suggestions.
      for (const [name, width, size] of [
        ['narrow', 320, '100%'],
        ['large-text', 640, '200%'],
        ['combined', 320, '200%'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await setTextSize(page, size);
        await layoutGate(page, `approval ${locale} ${name}`, '.translation-approval');
      }
      await expectNoAxeViolations(page);
      const approve = publication.getByRole('button', {
        name: /Vertaling in en goedkeuren|Approve translation in en/,
      });
      await approve.focus();
      await page.keyboard.press('Enter');
      await expect(publication).not.toContainText(/Machinevertaling|Machine translation/);
    });

    test('alt proposal can be dismissed, requested again and accepted without JavaScript', async ({
      page,
    }) => {
      await signInToFreshSite(page);
      await page
        .getByLabel(/AI-hulp voor deze site aanzetten|Enable assistance for this site/)
        .check();
      await page.getByLabel(/Ik stem in met het versturen|I consent to sending/).check();
      await page
        .getByRole('button', { name: /AI-instellingen opslaan|Save assistance settings/ })
        .click();
      const fixture = await imagePage(page, test.info().project.name);
      await page.goto(`${fixture.edit}/assist?task=alt&block=${fixture.blockId}&locale=nl`);
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      const first = new URL(page.url()).searchParams.get('suggestion');
      await ready(page);
      await expect(page.getByLabel(/Pas het voorstel aan|Edit the proposal/)).toBeVisible();
      await page.getByRole('button', { name: /Suggestie negeren|Dismiss suggestion/ }).click();
      await page.getByRole('button', { name: /^(Suggestie vragen|Request suggestion)$/ }).click();
      const second = new URL(page.url()).searchParams.get('suggestion');
      expect(second).not.toBe(first);
      await ready(page);
      await page
        .getByLabel(/Pas het voorstel aan|Edit the proposal/)
        .fill('Een geteste afbeelding');
      await acceptWithKeyboard(page);
      await expect(page).toHaveURL(`${fixture.edit}?saved=1`);
      const block = page.locator(`#block-${fixture.blockId}`);
      await expect(
        block.getByLabel(/^(Beschrijving \(alt-tekst\)|Description \(alt text\)) \(nl\)$/)
      ).toHaveValue('Een geteste afbeelding');
    });
  });
}

for (const locale of ['nl-NL', 'en-GB']) {
  test(`suggestion actions fit at 320 px and 200% in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({
      locale,
      viewport: NARROW,
      javaScriptEnabled: test.info().project.name === 'a11y',
      baseURL: 'http://127.0.0.1:4173',
      extraHTTPHeaders: {
        'x-forwarded-proto': 'http',
        'x-forwarded-for': `2001:db8:24a::${Math.floor(Math.random() * 65535).toString(16)}`,
      },
    });
    try {
      const page = await context.newPage();
      await signInToFreshSite(page);
      await page
        .getByLabel(
          locale.startsWith('nl')
            ? 'AI-hulp voor deze site aanzetten'
            : 'Enable assistance for this site'
        )
        .check();
      await page
        .getByLabel(
          locale.startsWith('nl') ? 'Ik stem in met het versturen' : 'I consent to sending'
        )
        .check();
      await page
        .getByRole('button', {
          name: locale.startsWith('nl') ? 'AI-instellingen opslaan' : 'Save assistance settings',
        })
        .click();
      await page.goto(`${base(page)}/content/new?type=page`);
      await page
        .getByLabel(locale.startsWith('nl') ? 'Slug' : 'Slug')
        .fill(`assist-layout-${locale}-${test.info().project.name}-${Date.now()}`.toLowerCase());
      await page.getByLabel(locale.startsWith('nl') ? 'Titel (nl)' : 'Title (nl)').fill('Bronkop');
      await page
        .getByLabel(locale.startsWith('nl') ? 'Titel (en)' : 'Title (en)')
        .fill('English heading');
      await page
        .getByRole('button', { name: locale.startsWith('nl') ? 'Concept maken' : 'Create draft' })
        .click();
      const edit = new URL(page.url()).pathname;
      await page.goto(`${edit}/assist?task=translate&from=nl&to=en&target=title`);
      await page
        .getByRole('button', {
          name: locale.startsWith('nl') ? 'Suggestie vragen' : 'Request suggestion',
        })
        .click();
      const suggestionId = new URL(page.url()).searchParams.get('suggestion');
      expect(suggestionId).toBeTruthy();
      await ready(page);
      for (const [name, width, zoom] of [
        ['narrow', 320, '100%'],
        ['large-text', 640, '200%'],
        ['combined', 320, '200%'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await setTextSize(page, zoom);
        await layoutGate(page, `${locale} ${name}`, '.assist-actions');
      }
    } finally {
      await context.close();
    }
  });
}
