// The publication boundary of the navigation in a browser (ADR 036 rule 7, ADR 018 rule 5): a
// writer, `author` with `content:write` and without `content:publish`, makes a menu in the editor
// like anyone who edits, but the preview offers no publish or take-offline control, and a
// publish or take-offline posted to the form actions anyway is refused.
// Core refuses the use cases in `service.test.ts`; this proves the screen and the form actions
// on top of them.
// Rejected: only checking that the buttons are absent (a hidden control proves nothing about
// the action behind it) and a writer API key (the screen is what hides the controls).
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { UseCaseError, capabilitiesFor, systemPrincipal, useCases } from '@mycel/core';
import { callApi, postUseCase } from '../api';
import { tenantId, withInvoker } from '../invoker';
import { login } from '../login';

interface Navigation {
  revisionId: string | null;
  document: { menus: { id: string; name: string }[]; placements: unknown };
}

const get = (request: APIRequestContext) => callApi<Navigation>(request, 'site.navigation.get', {});

export async function exerciseNavigationWriter(page: Page, request: APIRequestContext) {
  const writer = 'navigation-writer@probe.test';
  await withInvoker(async (invoker) => {
    try {
      await invoker.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'e2e'), {
        email: writer,
        capabilities: capabilitiesFor('author'),
      });
    } catch (e) {
      if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
    }
  });
  const name = `Schrijver ${randomUUID().slice(0, 8)}`;

  // Saving a draft is writing: the writer makes a menu.
  await login(page, '/admin/probe/navigation/new', writer, { 'accept-language': 'en' });
  await page.locator('#menu-name').fill(name);
  await page.getByRole('button', { name: 'Create menu' }).click();
  await expect(page).toHaveURL(/\/navigation\/[0-9a-f-]{36}\?(saved|merged)=1$/);
  const menuId = new URL(page.url()).pathname.split('/').pop()!;
  const saved = await get(request);
  expect(saved.document.menus.find((m) => m.id === menuId)?.name).toBe(name);

  // Publishing is not: the preview says who can and offers neither control.
  await page.goto('/admin/probe/navigation/preview/nl');
  await expect(page.locator('#navigation-publish')).toContainText(
    'Publishing needs the right to publish.'
  );
  await expect(page.getByRole('button', { name: 'Publish in nl' })).toHaveCount(0);
  await expect(page.locator('#navigation-publish summary')).toHaveCount(0);

  // Posted anyway with the writer's own session, both actions are refused by core: the form
  // failure names `forbidden`, which SvelteKit's cross-site 403 would not. Not read back from the
  // live pointer: the other project may publish meanwhile.
  const origin = new URL(page.url()).origin;
  for (const action of ['publish', 'unpublish']) {
    const refused = await page.request.post(`/admin/probe/navigation/preview/nl?/${action}`, {
      form: { revisionId: saved.revisionId! },
      headers: { origin },
    });
    expect(refused.status(), action).toBe(403);
    expect(await refused.text(), action).toContain('admin.error.forbidden');
  }

  // Leave the site as it was: the menu was never placed, so it can go.
  const after = await get(request);
  await postUseCase(request, 'site.navigation.update', {
    baseRevisionId: after.revisionId,
    document: {
      ...after.document,
      menus: after.document.menus.filter((m) => m.id !== menuId),
    },
  });
}
