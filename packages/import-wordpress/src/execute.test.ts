// The two rounds of `execute` on the memory adapter: an item whose blocks link to an item later in
// the plan is created without blocks in round one and gets them in round two. Only round two may
// report a link that did not come over, so a block that does arrive is never named in the report
// as left out (MY-286: BIJ1 Rotterdam had 31 such lines). The full run against Postgres is
// `packages/api/src/runtime/wordpress.test.ts`.

import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT } from '@mycel/core/testing';
import { execute } from './execute.js';
import type { ImportPlan, PlannedItem } from './plan.js';

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
});
