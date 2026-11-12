// The HTTP API of the run: scripts/e2e/e2e.mjs starts it at `E2E_API_URL` with `MYCEL_API_KEY`, a key
// of tenant probe. Specs seed and read through it, so the address, the key and the check that a
// call succeeded live here once instead of in a helper per describe block.
// Reusable content fixtures live beside the API call that creates or finds them; the spec keeps
// its task assertions. Rejected: copying their document setup into each writing/locale flow.
// Rejected: a Playwright fixture with its own request context, which would hide which spec talks
// to the API and add a second base URL next to the app's.

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import type { ContentDocument } from '@mycel/core';
import { login } from './login';
import { isA11y } from './project';

/** The API's base URL; skips the current test when the spec runs outside scripts/e2e/e2e.mjs. */
export function requireApi(): string {
  const url = process.env['E2E_API_URL'];
  test.skip(!url, 'run through scripts/e2e/e2e.mjs');
  return url!;
}

/** `POST /v1/<name>` with the seed key of tenant probe, as it answered. */
export const postUseCase = (
  request: APIRequestContext,
  name: string,
  data: unknown
): Promise<APIResponse> =>
  request.post(`${requireApi()}/v1/${name}`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data,
  });

/** A use case that must succeed, its JSON body; a refusal fails the test with the body. */
export async function callApi<T = any>(
  request: APIRequestContext,
  name: string,
  data: unknown
): Promise<T> {
  const response = await postUseCase(request, name, data);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

/** The seeded page of this project, by slug over the HTTP API. */
export async function seededPage(request: APIRequestContext): Promise<string> {
  const slug = `e2e-blokken-${test.info().project.name}`;
  const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
    type: 'page',
    slug,
  });
  expect(items, `${slug} is seeded by scripts/e2e/e2e.mjs`).toHaveLength(1);
  return `/admin/probe/content/${items[0]!.id}`;
}

/** An independent registry-backed page, so browser scenarios never depend on another save. */
export async function copiedBlockPage(request: APIRequestContext) {
  const source = await seededPage(request);
  const { revision } = await callApi<{ revision: { document: ContentDocument } }>(
    request,
    'content.item.get',
    { itemId: source.split('/').at(-1)! }
  );
  const slug = `blocks-${test.info().project.name}-${crypto.randomUUID()}`;
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug,
    document: revision.document,
  });
  return { edit: `/admin/probe/content/${item.id}`, slug };
}

/** A page with its text in the middle and a picture at both ends; `mediaId` from the seeded page. */
export async function pictureAtBothEnds(page: Page, request: APIRequestContext, name: string) {
  await login(page, await seededPage(request));
  const src = await page
    .locator('section.ui-block-card')
    .nth(4)
    .locator('[data-block-rest] img[data-block-image]')
    .getAttribute('src');
  const mediaId = /\/media\/([0-9a-f-]{36})\//.exec(src ?? '')?.[1];
  const image = (caption: string) => ({
    type: 'image',
    version: 1,
    props: { mediaId, decorative: false, alt: { nl: 'Een plein' }, caption: { nl: caption } },
  });
  const heading = (text: string) => ({
    type: 'heading',
    version: 1,
    props: { text: { nl: text } },
  });
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug: `${name}-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Lange pagina met beeld' },
      blocks: [
        image('Bovenaan'),
        ...Array.from({ length: 12 }, (_, i) => heading(`Kop ${i + 1}`)),
        image('Onderaan'),
      ],
    },
  });
  return { itemId: item.id, edit: `/admin/probe/content/${item.id}`, mediaId: mediaId! };
}

export async function article(request: APIRequestContext) {
  const slug = `writer-${test.info().project.name}-${Date.now()}`;
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Een artikel', en: 'An article' },
      blocks: [
        {
          type: 'rich-text',
          version: 1,
          props: {
            content: {
              nl: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Oude tekst' }] }],
              },
              en: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old text' }] }],
              },
            },
          },
        },
      ],
    },
  });
  return `/admin/probe/content/${item.id}`;
}

/**
 * An article whose quote stands between a text block in nl and en and one in nl only: removing or
 * moving the quote would join text of different locales, which core refuses. `blocks` reads the
 * stored block list back.
 */
export async function articleWithAmbiguousJoin(request: APIRequestContext) {
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const prose = (content: object) => ({ type: 'rich-text', version: 1, props: { content } });
  const quote = { text: { nl: 'Ertussen' }, attribution: { name: 'Bron' } };
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug: `join-${test.info().project.name}-${crypto.randomUUID()}`,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Samenvoegen' },
      blocks: [
        prose({ nl: doc('Boven'), en: doc('Above') }),
        { type: 'quote', version: 1, props: quote },
        prose({ nl: doc('Onder') }),
      ],
    },
  });
  const blocks = async () =>
    (
      await callApi<{ revision: { document: { blocks: { id: string }[] } } }>(
        request,
        'content.item.get',
        { itemId: item.id }
      )
    ).revision.document.blocks;
  return { edit: `/admin/probe/content/${item.id}`, blocks };
}

/**
 * A members article whose only paywall stands between two text blocks, with the marker teaser.
 * `document` reads the stored blocks and access back.
 */
export async function articleWithPaywall(request: APIRequestContext) {
  const prose = (text: string) => ({
    type: 'rich-text',
    version: 1,
    props: {
      content: {
        nl: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      },
    },
  });
  const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
    slug: `paywall-${test.info().project.name}-${crypto.randomUUID()}`,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Voor leden' },
      lead: { nl: 'Wat iedereen leest.' },
      access: { level: 'members', teaser: 'marker' },
      blocks: [prose('Iedereen'), { type: 'paywall', version: 1, props: {} }, prose('Leden')],
    },
  });
  const document = async () =>
    (
      await callApi<{
        revision: { document: { access: { teaser: unknown }; blocks: { type: string }[] } };
      }>(request, 'content.item.get', { itemId: item.id })
    ).revision.document;
  return { edit: `/admin/probe/content/${item.id}`, document };
}

/** Long formatted article and a native card, shared by the editor's initial-layout proof. */
export async function longArticle(request: APIRequestContext): Promise<string> {
  const paragraphs = Array.from({ length: 24 }, (_, i) => ({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `${i + 1}. A long article keeps its paragraphs in their original place while the editor starts. Readers can begin before JavaScript arrives.`,
      },
    ],
  }));
  const prose = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Inside the article' }],
      },
      ...paragraphs,
      {
        type: 'ordered_list',
        attrs: { start: 3 },
        content: [
          {
            type: 'list_item',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'A formatted point',
                    marks: [
                      { type: 'bold' },
                      {
                        type: 'footnote_reference',
                        attrs: { text: 'The note remains lossless.' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const { item } = await callApi(request, 'content.item.create', {
    slug: `geometry-${crypto.randomUUID()}`,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Een lang artikel', en: 'A long article' },
      blocks: [
        { type: 'rich-text', version: 1, props: { content: { nl: prose, en: prose } } },
        {
          type: 'quote',
          version: 1,
          props: {
            text: { nl: 'Een citaat na het artikel', en: 'A quote after the article' },
            attribution: { name: 'The editors' },
          },
        },
      ],
    },
  });
  return `/admin/probe/content/${item.id}`;
}
