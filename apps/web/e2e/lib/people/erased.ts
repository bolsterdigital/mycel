// ADR 034: an erased author's id stays on the article as a reference to nobody. The admin shows
// it checked under a neutral label, so a save does not drop it unseen, and unchecking removes it.
// The erasure runs as the worker would (register through the use case, then apply on the owner's
// connection). Rejected: a separate spec for it, which the e2e budget does not have room for.
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi, requireApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { applyErasuresOf, tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';

export async function exerciseErasedAuthor(page: Page, request: APIRequestContext) {
  requireApi();
  const run = `erased-author-${randomUUID().slice(0, 8)}`;
  const person = await callApi<{ id: string }>(request, 'content.person.create', {
    slug: run,
    name: `Gewist ${run}`,
  });
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug: run,
    document: {
      type: 'article',
      title: { nl: 'Gewiste auteur' },
      defaultLocale: 'nl',
      locales: ['nl'],
      blocks: [],
      authorIds: [person.id],
    },
  });
  const probe = await tenantId();
  await withInvoker((invoker) =>
    invoker.run(useCases.erasePeople, systemPrincipal(probe, 'e2e'), { personIds: [person.id] })
  );
  await applyErasuresOf();
  await login(page, `/admin/probe/content/${item.id}`);
  const authors = page.locator('#authors');
  // The operator's language may be either after other tests; the label says the same in both.
  const absent = authors.getByLabel(
    new RegExp(
      `^(Niet meer in het register|No longer in the register) \\(${person.id.slice(0, 8)}\\)$`
    )
  );
  await expect(absent).toBeChecked();
  await expect(authors).not.toContainText(`Gewist ${run}`);
  await expectNoAxeViolations(page);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'erased author', '#authors');
  await absent.uncheck();
  await page.getByRole('button', { name: /^(Opslaan|Save)$/ }).click();
  await expect(page).toHaveURL(new RegExp(`${item.id}\\?saved$`));
  const { revision } = await callApi<{ revision: { document: { authorIds: string[] } } }>(
    request,
    'content.item.get',
    { itemId: item.id }
  );
  expect(revision.document.authorIds).toEqual([]);
}
