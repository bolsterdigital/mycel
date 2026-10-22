// Content use cases. Business rules live here (ADR 001 rule 5); the database's unique index on
// (tenant_id, slug) is the second line of defence, not the first.

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import { defineUseCase } from '../registry.js';
import { Page, PageInput, PageSlug, referencedFormIds } from './model.js';
import './ports.js';

export const getPage = defineUseCase({
  name: 'content.page.get',
  kind: 'query',
  description: 'Get a page (metadata and block tree) by its slug.',
  requires: 'content:read',
  input: z.object({ slug: PageSlug }),
  output: Page,
  resource: { uriTemplate: 'mycel://pages/{slug}' },
  examples: [{ input: { slug: 'signup' } }],
  async handler(ctx, { slug }) {
    const page = await ctx.pages.findBySlug(slug);
    if (!page) throw new UseCaseError('not_found', `no page with slug "${slug}"`);
    return page;
  },
});

export const createPage = defineUseCase({
  name: 'content.page.create',
  kind: 'command',
  description:
    'Create a page from a block tree. Localisable fields are { locale: value } maps; every referenced form must exist.',
  requires: 'content:write',
  consumes: null,
  input: PageInput,
  output: Page,
  examples: [
    {
      input: {
        slug: 'about',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Over ons', en: 'About us' },
        blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Wie we zijn' } } }],
      },
      note: 'No signup-form block: a form reference must exist, and the example has no tenant data.',
    },
  ],
  async handler(ctx, input) {
    if (await ctx.pages.findBySlug(input.slug))
      throw new UseCaseError('conflict', `a page with slug "${input.slug}" already exists`);
    const missing: string[] = [];
    for (const id of referencedFormIds(input.blocks))
      if (!(await ctx.forms.findById(id))) missing.push(id);
    if (missing.length)
      throw new UseCaseError(
        'invalid_input',
        `page references unknown form(s): ${missing.join(', ')}`,
        missing.map((id) => ({ path: 'blocks', message: `content.form-reference.unknown:${id}` }))
      );
    const now = ctx.clock.now().toISOString();
    const page: Page = { ...input, id: ctx.ids.next(), createdAt: now, updatedAt: now };
    await ctx.pages.insert(page);
    return page;
  },
});
