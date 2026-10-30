// The demo content stays valid as the block schemas move: both documents parse, are
// ready to publish in nl and en, use every block type at its current version between them, and
// the seed creates, publishes and then leaves them alone.

import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS } from '../content/block-types.js';
import { assignBlockIds } from '../content/blocks.js';
import { ContentDocument, ContentDocumentInput, readinessIssues } from '../content/model.js';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { exampleId } from '../util/ids.js';
import { DEMO_IMAGES, demoArticle, demoPage, seedDemoContent } from './demo-content.js';
import { adminOf, probeForm } from './fixtures.js';
import { MemoryUnitOfWork } from './memory.js';

const FORM = exampleId(0xf00d);
const media = {
  market: exampleId(0xd101),
  bakery: exampleId(0xd102),
  measuring: exampleId(0xd103),
  signatures: exampleId(0xd104),
};
const documents = [
  demoPage({ formId: FORM, media }).document,
  demoArticle({ formId: FORM, media, pageId: exampleId(0xc101) }).document,
];

/** A PNG signature and IHDR of the image's size: all the memory image processor reads. */
async function pngHeader({ width, height }: { width: number; height: number }) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe('demo content', () => {
  it.each(documents.map((d) => [d.type, d] as const))(
    'the %s is a valid document, ready in nl and en',
    (_, input) => {
      const parsed = ContentDocumentInput.parse(input);
      const stored = ContentDocument.parse({
        ...parsed,
        blocks: assignBlockIds(
          parsed.blocks,
          (() => {
            let n = 0;
            return () => exampleId(0xb000 + n++);
          })()
        ),
      });
      expect(stored.blocks.length).toBeGreaterThanOrEqual(10);
      expect(stored.blocks.length).toBeLessThanOrEqual(14);
      expect(stored.lead?.['nl']).toBeTruthy();
      expect(stored.heroImageId).toBeDefined();
      for (const locale of ['nl', 'en']) expect(readinessIssues(stored, locale)).toEqual([]);
    }
  );

  it('uses every block type at its current version', () => {
    const used = new Map(documents.flatMap((d) => d.blocks.map((b) => [b.type, b.version])));
    for (const [type, definition] of Object.entries(BLOCK_DEFINITIONS))
      expect([type, used.get(type as keyof typeof BLOCK_DEFINITIONS)]).toEqual([
        type,
        definition.version,
      ]);
  });

  it('seeds both items published in every locale, once', async () => {
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = adminOf();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));

    const first = await seedDemoContent(invoker, admin, { formId: FORM, render: pngHeader });
    expect(first.created).toBe(true);
    for (const item of [first.page, first.article])
      expect(
        item.publication.map((p) => [p.locale, p.status]).sort((x, y) => x[0]!.localeCompare(y[0]!))
      ).toEqual([
        ['en', 'published'],
        ['nl', 'published'],
      ]);
    const { items } = await invoker.run(useCases.listMedia, admin, {});
    expect(items.map((m) => m.filename).sort()).toEqual(DEMO_IMAGES.map((i) => i.filename).sort());

    const again = await seedDemoContent(invoker, admin, { formId: FORM, render: pngHeader });
    expect(again).toMatchObject({ created: false, page: { id: first.page.id } });
    expect((await invoker.run(useCases.listMedia, admin, {})).items).toHaveLength(4);
  });
});
