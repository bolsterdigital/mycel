// Moving a legacy hero block into the document header (ADR 025 rule 5, MY-110 B4). The proposal is
// a pure reading of one document: what would move, what is already the same, and what stands in
// the way. The command applies that same proposal and writes one draft revision; published,
// scheduled and older revisions are never touched (rule 6), and publishing stays a separate act.
//
// The rule is lossless or nothing. A header field is filled only where it is empty and accepted
// where it is equal; anything else is a conflict and writes nothing, so the editor decides by
// changing the block or the header. A hero's own caption or credit is a conflict as well: the
// header always shows the asset's (#86), so an override, even an empty caption that hides the
// asset's, has nowhere to go. Actions become a separate `cta` at the hero's position. Without one
// a block teaser (`access.teaser.blocks`) counts one block less, or the first paid block would
// slip into what everyone can read.
//
// Rejected: choosing a winner per field (a heuristic the ADR forbids), comparing an override with
// the asset's value (it needs media reads for a case the editor settles in one edit), keeping the
// override in a new header field (a schema change for legacy data), and mapping `variant: cover`
// onto `presentation.header` (an article's cover is its own decision; the layout is reported).

import { z } from 'zod';
import { notFound, UseCaseError } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { BLOCK_DEFINITIONS, BlockAction } from '../block-types.js';
import { BlockId, allBlocks, type Block } from '../blocks.js';
import type { ContentDocument } from '../model.js';
import { OperationResult } from '../operations.js';
import { assertBase, finalize, lockItem, writeRevision } from '../service.js';

/** The longest lead a document takes; a hero's body may be longer (5000). */
const LEAD_MAX = 1000;

export const HERO_CONVERSION_CONFLICTS = [
  'several-heroes',
  'not-first',
  'title',
  'lead',
  'lead-too-long',
  'image',
  'alt',
  'caption',
  'credit',
] as const;
export type HeroConversionConflict = (typeof HERO_CONVERSION_CONFLICTS)[number];

export const HeroConversion = z.object({
  /** The hero this proposal is about: the first one when a document has several. */
  heroId: BlockId,
  /** Source and target per field and locale; `header` null means the field is empty now. */
  fields: z.array(
    z.object({
      field: z.enum(['title', 'lead', 'image', 'alt']),
      locale: Locale.nullable(),
      hero: z.string(),
      header: z.string().nullable(),
    })
  ),
  /** Empty means the conversion can be applied. */
  conflicts: z.array(
    z.object({ code: z.enum(HERO_CONVERSION_CONFLICTS), locale: Locale.nullable() })
  ),
  /** The separate block the hero's actions become, at its position. */
  cta: z
    .object({
      title: z.record(Locale, z.string()),
      actions: z.array(BlockAction),
      width: z.string(),
      align: z.string(),
    })
    .nullable(),
  /** What a block teaser becomes, when it changes. */
  teaser: z.object({ from: z.number(), to: z.number() }).nullable(),
  /** The block's own layout, which the header does not take over. */
  layout: z.object({ variant: z.string(), width: z.string(), align: z.string() }),
});
export type HeroConversion = z.infer<typeof HeroConversion>;

type HeroProps = z.output<(typeof BLOCK_DEFINITIONS)['hero']['props']>;
type Field = HeroConversion['fields'][number];
type Conflict = HeroConversion['conflicts'][number];
type Texts = Partial<Record<string, string>> | null | undefined;

/** One row per locale the hero has text in; a differing target is a conflict in that locale. */
function textFields(
  field: 'title' | 'lead' | 'alt',
  code: 'title' | 'lead' | 'alt',
  hero: Texts,
  header: Texts
): { fields: Field[]; conflicts: Conflict[] } {
  const fields: Field[] = [];
  const conflicts: Conflict[] = [];
  for (const [locale, value] of Object.entries(hero ?? {})) {
    if (value === undefined) continue;
    const current = header?.[locale] ?? null;
    fields.push({ field, locale, hero: value, header: current });
    if (current !== null && current !== value) conflicts.push({ code, locale });
  }
  return { fields, conflicts };
}

/**
 * What converting this document's hero would do, or null without a hero. Pure, so the editor shows
 * exactly what the command will apply.
 */
export function proposeHeroConversion(doc: ContentDocument): HeroConversion | null {
  const heroes = allBlocks(doc.blocks).filter((b) => b.type === 'hero');
  const hero = heroes[0];
  if (!hero) return null;
  const props = hero.props as HeroProps;
  const conflicts: Conflict[] = [];
  const conflict = (code: HeroConversionConflict, locale: string | null = null) =>
    conflicts.push({ code, locale });

  if (heroes.length > 1) conflict('several-heroes');
  if (doc.blocks[0]?.id !== hero.id) conflict('not-first');

  const title = textFields('title', 'title', props.title, doc.title);
  const lead = textFields('lead', 'lead', props.body, doc.lead);
  const fields = [...title.fields, ...lead.fields];
  conflicts.push(...title.conflicts, ...lead.conflicts);
  for (const row of lead.fields)
    if (row.header === null && row.hero.length > LEAD_MAX) conflict('lead-too-long', row.locale);

  const image = props.image;
  if (image) {
    const current = doc.heroImageId ?? null;
    fields.push({ field: 'image', locale: null, hero: image.mediaId, header: current });
    if (current !== null && current !== image.mediaId) conflict('image');
    // A decorative hero has nothing to carry over; a header's own description simply stays.
    const alt = textFields('alt', 'alt', image.decorative ? null : image.alt, doc.heroAlt);
    fields.push(...alt.fields);
    conflicts.push(...alt.conflicts);
    for (const locale of Object.keys(image.caption ?? {})) conflict('caption', locale);
    if (image.credit) conflict('credit');
  }

  const { actions, variant, width, align } = props;
  const teaser = doc.access.teaser;
  return {
    heroId: hero.id,
    fields,
    conflicts,
    cta: actions.length ? { title: props.title, actions, width, align } : null,
    teaser:
      typeof teaser === 'object' && !actions.length && teaser.blocks > 0
        ? { from: teaser.blocks, to: teaser.blocks - 1 }
        : null,
    layout: { variant, width, align },
  };
}

/** The document after a conversion without conflicts. `ctaId` is used only with actions. */
export function applyHeroConversion(
  doc: ContentDocument,
  conversion: HeroConversion,
  ctaId: string
): ContentDocument {
  const fill = (field: Field['field'], current: Texts) => {
    const moved = conversion.fields.filter((f) => f.field === field && f.header === null);
    return moved.length
      ? {
          ...(current as Record<string, string>),
          ...Object.fromEntries(moved.map((f) => [f.locale, f.hero])),
        }
      : current;
  };
  const lead = fill('lead', doc.lead);
  const heroAlt = fill('alt', doc.heroAlt);
  const image = conversion.fields.find((f) => f.field === 'image');
  const heroImageId = image?.hero ?? doc.heroImageId;
  const cta = conversion.cta && {
    id: ctaId,
    type: 'cta',
    version: BLOCK_DEFINITIONS.cta.version,
    props: { variant: 'band', ...conversion.cta },
  };
  const blocks = [
    ...(cta ? [cta as unknown as Block] : []),
    ...doc.blocks.filter((b) => b.id !== conversion.heroId),
  ];
  return {
    ...doc,
    title: fill('title', doc.title) as ContentDocument['title'],
    ...(lead ? { lead: lead as ContentDocument['lead'] } : {}),
    ...(heroImageId ? { heroImageId } : {}),
    ...(heroAlt ? { heroAlt: heroAlt as ContentDocument['heroAlt'] } : {}),
    access: conversion.teaser
      ? { ...doc.access, teaser: { blocks: conversion.teaser.to } }
      : doc.access,
    blocks,
  };
}

export const getHeroConversion = defineUseCase({
  name: 'content.hero.propose',
  kind: 'query',
  description:
    'Show what moving the hero block of a revision into the document header would do: source and target per field and locale, conflicts, the separate CTA for its actions. Writes nothing.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ itemId: z.string().guid(), revisionId: z.string().guid().optional() }),
  output: z.object({ conversion: HeroConversion.nullable() }),
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId, revisionId }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const revision = await ctx.content.revision(itemId, revisionId ?? item.latestRevisionId);
    if (!revision) throw notFound('revision');
    return { conversion: proposeHeroConversion(revision.document) };
  },
});

export const convertHero = defineUseCase({
  name: 'content.hero.convert',
  kind: 'command',
  description:
    'Move the hero block into the document header as one new draft revision; its actions become a separate CTA at its position. Refuses with invalid_input and writes nothing when the header holds something else, when there are several heroes, or when the hero is not the first block. Publishing stays separate. Reports the retired hero id and every created id.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({
    itemId: z.string().guid(),
    baseRevisionId: z.string().guid(),
    blockId: BlockId,
  }),
  output: OperationResult,
  examples: [
    { input: { itemId: exampleId(0x1), baseRevisionId: exampleId(0x2), blockId: 'hero' } },
  ],
  async handler(ctx, { itemId, baseRevisionId, blockId }) {
    const item = await lockItem(ctx, itemId);
    assertBase(item, baseRevisionId);
    const base = await ctx.content.revision(itemId, baseRevisionId);
    if (!base) throw notFound('revision');
    const conversion = proposeHeroConversion(base.document);
    if (conversion?.heroId !== blockId)
      throw new UseCaseError('invalid_input', 'that block is not the hero of this document', [
        { path: 'blockId', message: 'content.block.unknown', params: { id: blockId } },
      ]);
    if (conversion.conflicts.length)
      throw new UseCaseError(
        'invalid_input',
        'the hero cannot move into the header without losing something',
        conversion.conflicts.map(({ code, locale }) => ({
          path: 'blockId',
          message: `content.hero-conversion.${code}`,
          ...(locale ? { params: { locale } } : {}),
        }))
      );
    const ctaId = ctx.ids.next();
    const next = applyHeroConversion(base.document, conversion, ctaId);
    const saved = await writeRevision(ctx, item, finalize(ctx, next, next.blocks));
    return {
      ...saved,
      created: conversion.cta ? [ctaId] : [],
      retired: [blockId],
      merged: [],
    };
  },
});
