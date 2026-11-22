// Wings dossiers through plan and execute on the memory adapter (MY-290, briefing "Done when"):
// one landing page becomes one dossier page, its article and page become members, a regular
// category with the same name adds no membership, and a reader can walk from the dossier page to
// both members and back from the article. A term without a landing page, a term two landings
// claim and a fourth dossier each give a report line on the member that names it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT } from '@mycel/core/testing';
import { execute } from './execute.js';
import { plan, placeholder, type ImportPlan } from './plan.js';

const XML = readFileSync(new URL('../fixtures/dossier-export.xml', import.meta.url), 'utf8');
const item = (p: ImportPlan, postId: number) =>
  p.items.find((i) => i.sources.some((s) => s.id === postId))!;
const lines = (p: ImportPlan, code: string) =>
  p.report.filter((l) => l.code === code).map((l) => `${l.postId} ${l.detail ?? ''}`.trim());

describe('Wings dossiers (MY-290)', () => {
  const planned = plan(XML);
  const water = placeholder('item', 501);

  it('makes each landing a dossier page and its members name it', () => {
    expect(item(planned, 501).document).toMatchObject({
      type: 'page',
      profile: 'dossier',
      featuredImageId: placeholder('media', 101),
      featured: { description: { nl: 'Waarom schoon water ons allemaal raakt.' } },
    });
    expect(item(planned, 501).document.dossiers).toBeUndefined();
    // The article hides its box; the same-named category is its section, not a second dossier.
    expect(item(planned, 601).document).toMatchObject({
      dossiers: [{ itemId: water }],
      showDossier: false,
      sectionId: placeholder('section', 1),
    });
    expect(item(planned, 602).document).toMatchObject({ dossiers: [{ itemId: water }] });
    expect(item(planned, 602).document.showDossier).toBeUndefined();
    expect(item(planned, 603).document.dossiers).toEqual(
      [501, 505, 506].map((id) => ({ itemId: placeholder('item', id) }))
    );
  });

  it('turns the dossier grid into overviews of its members', () => {
    const overviews = item(planned, 501).document.blocks.filter((b) => b.type === 'overview');
    expect(overviews.map((b) => b.props)).toEqual([
      expect.objectContaining({ source: 'article', dossierId: water, limit: '6' }),
      expect.objectContaining({ source: 'page', dossierId: water, limit: '6' }),
    ]);
    expect(lines(planned, 'overview.dossier-split')).toEqual(['501']);
  });

  it('reports what it cannot link on the member, and the old dossier addresses', () => {
    expect(lines(planned, 'dossier.unlinked')).toEqual(['602 Cultuur']);
    expect(lines(planned, 'dossier.ambiguous')).toEqual(['603 Verkeer: 2 landing pages']);
    expect(lines(planned, 'dossier.extra')).toEqual(['603 Zorg']);
    expect(lines(planned, 'item.slug-changed')).toContain(
      '501 https://voorbeeld.example/dossiers/schoon-water/ → /schoon-water'
    );
  });

  it('plans the same export the same way twice', () => {
    expect(plan(XML)).toEqual(planned);
  });

  it('imports the dossier so a reader walks from it to both members and back', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'importer');
    const result = await execute(planned, {
      invoker,
      principal,
      media: async () => ({ error: 'not needed' }),
    });
    expect(
      result.report.filter((l) => l.code.endsWith('failed') && l.code !== 'media.failed')
    ).toEqual([]);
    expect(result.items.filter((i) => i.status === 'published')).toHaveLength(9);

    const get = (type: 'page' | 'article', slug: string) =>
      invoker.run(useCases.getPublished, principal, { type, slug });
    const landing = await get('page', 'schoon-water');
    const listed = [];
    for (const block of landing.blocks.filter((b) => b.type === 'overview')) {
      const read = await invoker.run(useCases.getOverview, principal, {
        props: block.props as never,
        locale: 'nl',
      });
      listed.push(...read.entries);
    }
    expect(listed.map((e) => e.slug).sort()).toEqual([
      'alles-tegelijk',
      'meetresultaten',
      'zo-meten-wij',
    ]);

    // The page shows its box back to the dossier; the article hid it, as in Wings.
    expect(((await get('page', 'zo-meten-wij')).dossiers ?? []).map((d) => d.slug)).toEqual([
      'schoon-water',
    ]);
    expect((await get('article', 'meetresultaten')).dossiers ?? []).toEqual([]);
    expect(((await get('article', 'alles-tegelijk')).dossiers ?? []).map((d) => d.slug)).toEqual([
      'schoon-water',
      'wonen',
      'groen',
    ]);
  });
});
