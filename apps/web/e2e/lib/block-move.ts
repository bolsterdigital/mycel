// The same move contract on page fields and article portals; keep setup out of the bounded spec.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { callApi } from './api';
import { login } from './login';
import { editorReady, reloadsEditor } from './editor';
import { layoutGate, NARROW, setTextSize } from './layout';
import { expectNoAxeViolations } from './axe';

export async function exerciseBlockMove(
  page: Page,
  request: APIRequestContext,
  type: 'page' | 'article'
) {
  const blocks: object[] = ['one', 'two', 'three'].map((id) => ({
    id,
    type: 'heading',
    version: 1,
    props: { text: { nl: id } },
  }));
  const tail = type === 'article' ? ['prose', 'two', 'three'] : ['two', 'three'];
  if (type === 'article')
    blocks.splice(1, 0, {
      id: 'prose',
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Prose stays intact.' }] },
            ],
          },
        },
      },
    });
  const { item } = await callApi(request, 'content.item.create', {
    slug: `move-${type}-${Date.now()}`,
    document: {
      type,
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Verplaatsen' },
      blocks,
    },
  });
  await login(page, `/admin/probe/content/${item.id}`);
  await editorReady(page);
  await expect(page.locator('#item-edit')).toHaveAttribute('data-block-move', '');
  const grip = () => page.locator('[data-block-card="block-one"] [data-block-move]');
  // The title is outside every card and must still save with an action from inside the writer.
  const title = page.locator('[name="title.nl"]');
  await title.fill('Voor het verplaatsen getypt');
  await page.locator('#block-one > summary').click();
  await page.locator('[name="b.one.p.text.nl"]').fill('Ook binnen het blok getypt');
  await page.locator('[data-block-all="collapse"]').click();
  await grip().focus();
  await grip().press('Space');
  await grip().press('ArrowDown');
  await grip().press('Escape');
  await expect(grip()).toBeFocused();
  await expect(page.locator('[data-move-place]')).toHaveCount(0);
  await reloadsEditor(page, async () => {
    await grip().press('Space');
    await grip().press('End');
    await grip().press('Enter');
  });
  const read = async () =>
    (await callApi(request, 'content.item.get', { itemId: item.id })).revision.document;
  expect((await read()).blocks.map((block: { id: string }) => block.id)).toEqual([...tail, 'one']);
  expect((await read()).title.nl).toBe('Voor het verplaatsen getypt');
  expect((await read()).blocks.at(-1).props.text.nl).toBe('Ook binnen het blok getypt');
  const moving = await grip().boundingBox();
  const before = await page
    .locator(
      type === 'article' ? '.ProseMirror > [data-mycel-prose]' : '[data-block-card="block-two"]'
    )
    .boundingBox();
  expect(moving).toBeTruthy();
  expect(before).toBeTruthy();
  await reloadsEditor(page, async () => {
    await page.mouse.move(moving!.x + 10, moving!.y + 10);
    await page.mouse.down();
    await page.mouse.move(before!.x + 10, before!.y + 5, { steps: 8 });
    await page.mouse.up();
  });
  expect((await read()).blocks.map((block: { id: string }) => block.id)).toEqual(['one', ...tail]);
  // Chromium's touch protocol generates genuine touch PointerEvents and pointer capture.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const from = await grip().boundingBox();
  const last = await page.locator('[data-block-card="block-three"]').boundingBox();
  await reloadsEditor(page, async () => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from!.x + 10, y: from!.y + 10 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: last!.x + 10, y: last!.y + last!.height - 5 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  });
  expect((await read()).blocks.map((block: { id: string }) => block.id)).toEqual([...tail, 'one']);
  await cdp.detach();
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, '.ui-block-card-head');
  await expectNoAxeViolations(page);
  const screenshot = test.info().outputPath(`block-move-${type}-320-200.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await test.info().attach('UI-gate', { path: screenshot, contentType: 'image/png' });
}
