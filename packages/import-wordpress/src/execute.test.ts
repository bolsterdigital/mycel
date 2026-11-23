// The two rounds of `execute` on the memory adapter: an item whose blocks link to an item later in
// the plan is created without blocks in round one and gets them in round two. Only round two may
// report a link that did not come over, so a block that does arrive is never named in the report
// as left out (MY-286: BIJ1 Rotterdam had 31 such lines). The full run against Postgres is
// `packages/api/src/runtime/wordpress.test.ts`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT } from '@mycel/core/testing';
import { execute } from './execute.js';
import { plan, type ImportPlan, type PlannedItem } from './plan.js';

const LATER = '00000000-0000-4000-8004-000000000002';
const NEVER = '00000000-0000-4000-8004-000000000099';

const linkTo = (itemId: string, id: string) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: {
    content: {
      nl: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Lees', marks: [{ type: 'link', attrs: { itemId } }] }],
          },
        ],
      },
    },
  },
});

const page = (ref: string, slug: string, blocks: unknown[]): PlannedItem => ({
  ref,
  sources: [{ id: Number(ref.slice(-3)), locale: 'nl' }],
  slug,
  status: 'draft',
  publishedAt: null,
  document: {
    type: 'page',
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: slug },
    blocks: blocks as never,
  },
});

describe('execute', () => {
  const campaignExport = () =>
    readFileSync(new URL('../fixtures/campaign-export.xml', import.meta.url), 'utf8');

  it.each([
    { form: '#facade', progress: '#eee', expectedProgress: '#eeeeee', ink: '#252134' },
    { form: '#18352e', progress: '#242044', expectedProgress: '#242044', ink: '#fff0da' },
  ])('imports campaign colours from resolved tokens ($form)', async (colours) => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'importer');
    const before = await invoker.run(useCases.getSiteTheme, principal, {});
    const prefix = '--wings-campaign-sidebar-';
    const importPlan = plan(campaignExport(), {
      brandTokens: {
        css_vars: {
          [prefix + 'form-bg-color']: colours.form,
          [prefix + 'form-text-color']: colours.ink,
          [prefix + 'progress-bg-color']: colours.progress,
          [prefix + 'progress-text-color']: colours.ink,
          [prefix + 'progress-bar-bg-color']: colours.ink,
          '--wings-primary-color': '#ffaa00',
        },
      },
    });
    const result = await execute(importPlan, {
      invoker,
      principal,
      media: () => Promise.resolve({ error: 'none' }),
    });
    expect(result.report.filter((line) => line.code.startsWith('theme.'))).toEqual([]);
    const { value } = await invoker.run(useCases.getSiteTheme, principal, {});
    expect(value.palettes).toEqual({
      dark: before.value.palettes.dark,
      light: {
        ...before.value.palettes.light,
        campaignForm: { background: colours.form, foreground: colours.ink },
        campaignProgress: { background: colours.expectedProgress, foreground: colours.ink },
        campaignProgressFill: colours.ink,
      },
    });
  });

  it.each([
    { brand: undefined, remarks: 0 },
    { brand: { tokens: { primary_color: '#ab1234' } }, remarks: 1 },
    {
      brand: {
        css_vars: {
          '--wings-campaign-sidebar-form-bg-color': 'var(--wings-primary-color)',
          '--wings-campaign-sidebar-form-text-color': '#ffffff',
          '--wings-campaign-sidebar-progress-bg-color': '#ffffff',
          '--wings-campaign-sidebar-progress-text-color': '#ffffff',
          '--wings-campaign-sidebar-progress-bar-bg-color': '#ffffff',
        },
      },
      remarks: 3,
    },
  ])(
    'keeps the theme when campaign colours are absent or unusable ($remarks remarks)',
    async ({ brand, remarks }) => {
      const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
      const principal = systemPrincipal(TENANT, 'importer');
      const before = await invoker.run(useCases.getSiteTheme, principal, {});
      const result = await execute(plan(campaignExport(), { brandTokens: brand }), {
        invoker,
        principal,
        media: () => Promise.resolve({ error: 'none' }),
      });
      expect(result.report.filter((line) => line.code === 'theme.campaign-skipped')).toHaveLength(
        remarks
      );
      expect(await invoker.run(useCases.getSiteTheme, principal, {})).toEqual(before);
    }
  );

  it('reports a missing linked item in round two only, and never one that came over', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'importer');
    const plan: ImportPlan = {
      site: { title: 'Proef', url: 'https://example.org' },
      defaultLocale: 'nl',
      featuredAsHeader: false,
      locales: ['nl'],
      media: [],
      people: [],
      groups: [],
      sections: [],
      items: [
        page('00000000-0000-4000-8004-000000000001', 'eerst', [
          linkTo(LATER, 'a'),
          linkTo(NEVER, 'b'),
        ]),
        page(LATER, 'later', []),
      ],
      campaigns: [],
      report: [],
    };
    const result = await execute(plan, {
      invoker,
      principal,
      media: () => Promise.resolve({ error: 'none' }),
    });
    expect(result.report).toEqual([
      {
        code: 'block.reference-missing',
        block: 'rich-text',
        position: 2,
        postId: 1,
        title: 'eerst',
      },
    ]);
    const first = result.items.find((i) => i.slug === 'eerst')!;
    const { revision } = await invoker.run(useCases.getItem, principal, { itemId: first.itemId });
    expect(revision.document.blocks.map((b) => b.id)).toEqual(['a']);
    expect(JSON.stringify(revision.document)).toContain(result.ids[LATER]!);
  });

  it("links a split header's button in round two, and leaves out one whose item is gone", async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'importer');
    const split = (ref: string, slug: string, itemId: string): PlannedItem => {
      const planned = page(ref, slug, []);
      Object.assign(planned.document, {
        presentation: {
          header: 'split',
          action: { label: { nl: 'Word actief' }, target: { kind: 'item', itemId } },
        },
      });
      return planned;
    };
    const plan: ImportPlan = {
      site: { title: 'Proef', url: 'https://example.org' },
      defaultLocale: 'nl',
      featuredAsHeader: false,
      locales: ['nl'],
      media: [],
      people: [],
      groups: [],
      sections: [],
      items: [
        split('00000000-0000-4000-8004-000000000001', 'home', LATER),
        split('00000000-0000-4000-8004-000000000003', 'kwijt', NEVER),
        page(LATER, 'later', []),
      ],
      campaigns: [],
      report: [],
    };
    const result = await execute(plan, {
      invoker,
      principal,
      media: () => Promise.resolve({ error: 'none' }),
    });
    expect(result.report).toEqual([
      {
        code: 'block.reference-missing',
        block: 'presentation.action',
        position: 0,
        postId: 3,
        title: 'kwijt',
      },
    ]);
    const doc = async (slug: string) =>
      (
        await invoker.run(useCases.getItem, principal, {
          itemId: result.items.find((i) => i.slug === slug)!.itemId,
        })
      ).revision.document;
    expect(await doc('home')).toMatchObject({
      presentation: {
        header: 'split',
        action: { target: { kind: 'item', itemId: result.ids[LATER] } },
      },
    });
    expect(await doc('kwijt')).toMatchObject({ presentation: { header: 'split' } });
    expect(await doc('kwijt')).not.toHaveProperty('presentation.action');
  });
});
