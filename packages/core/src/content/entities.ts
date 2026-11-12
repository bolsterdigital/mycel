// Authors, sections and patterns (ADR 012 rules 2, 3 and 8): tenant entities next to content,
// each with create, update, get and list. Slugs are chosen at create and fixed afterwards; a
// rename with redirects is #9. Every query is editorial (not on the anonymous allowlist): an author's
// e-mail address is internal data and never reaches a public principal.
//
// The three are written out instead of generated from one factory: their inputs differ, and an
// agent reading this file should see each use case as it is registered. Rejected: a generic
// `content.entity.*` with a kind field, which would blur the capability and the MCP tool list.

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { assignBlockIds, type BlockInput } from './blocks.js';
import {
  Person,
  PersonInput,
  Pattern,
  PatternInput,
  Section,
  SectionInput,
  Slug,
} from './model.js';
import type { SluggedRepository } from './ports.js';
import {
  DEFAULT_PAGE_SIZE,
  blockReferenceIssues,
  recordMediaUsages,
  requireBlockTypes,
} from './service.js';
import './ports.js';
import { withoutErasedCredits } from './people/erasure.js';
import { exampleId } from '../util/ids.js';

const Limit = z.number().int().min(1).max(MAX_PAGE_SIZE).optional();

const slugTaken = (what: string, slug: string) =>
  new UseCaseError('conflict', `${what} with slug "${slug}" already exists`);

async function assertFreeSlug<T extends { id: string; slug: string; updatedAt: string }>(
  repo: SluggedRepository<T>,
  slug: string,
  what: string
): Promise<void> {
  if (await repo.findBySlug(slug)) throw slugTaken(what, slug);
}

const stamp = (ctx: TransactionContext) => ctx.clock.now().toISOString();

/**
 * The base check of an author or section update (ADR 027): the caller sends the `updatedAt` it
 * read, and the update fails with `conflict` when the record changed since, naming when. Checked
 * before the write and again by the write itself (compare-and-set), so a concurrent update between
 * the two is refused too. Rejected: a version column (a migration for what the stamp already
 * says, once every write moves it forward) and no check at all (a bulk change of authors would
 * overwrite an editor's correction unseen).
 */
const entityConflict = (what: string, updatedAt: string) =>
  new UseCaseError('conflict', `the ${what} changed since baseUpdatedAt`, [
    { path: 'baseUpdatedAt', message: 'content.entity.conflict', params: { updatedAt } },
  ]);

/**
 * The stamp of a write on `base`: now, but always later than the base, so two writes on one base
 * never carry the same stamp and the compare-and-set can tell them apart (a clock that did not
 * move, two writes in one millisecond).
 */
const nextStamp = (ctx: TransactionContext, base: string) =>
  new Date(Math.max(ctx.clock.now().getTime(), Date.parse(base) + 1)).toISOString();

async function updateEntity<T extends { id: string; slug: string; updatedAt: string }>(
  ctx: TransactionContext,
  repo: SluggedRepository<T>,
  what: string,
  id: string,
  baseUpdatedAt: string,
  build: (current: T, updatedAt: string) => T
): Promise<T> {
  const current = await repo.get(id);
  if (!current) throw notFound(what);
  if (Date.parse(current.updatedAt) !== Date.parse(baseUpdatedAt))
    throw entityConflict(what, current.updatedAt);
  const next = build(current, nextStamp(ctx, current.updatedAt));
  if (await repo.update(next, current.updatedAt)) return next;
  const now = await repo.get(id);
  if (!now) throw notFound(what);
  throw entityConflict(what, now.updatedAt);
}

/** The `updatedAt` a caller read: what an update of an author or section is based on. */
const BaseUpdatedAt = z.string().datetime({ offset: true });

export const createPerson = defineUseCase({
  name: 'content.person.create',
  kind: 'command',
  description: 'Create a person profile; a person need not have an operator account to be one.',
  requires: 'content:write',
  consumes: null,
  input: PersonInput.extend({ slug: Slug }),
  output: Person,
  examples: [
    { input: { slug: 'sam-de-vries', name: 'Sam de Vries', bio: { nl: 'Verslaggever.' } } },
  ],
  async handler(ctx, { slug, ...fields }) {
    await assertFreeSlug(ctx.authors, slug, 'a person');
    const now = stamp(ctx);
    const author: Person = { ...fields, id: ctx.ids.next(), slug, createdAt: now, updatedAt: now };
    if (!(await ctx.authors.insert(author))) throw slugTaken('a person', slug);
    return author;
  },
});

export const updatePerson = defineUseCase({
  name: 'content.person.update',
  kind: 'command',
  description:
    'Replace the fields of a person profile; the slug stays as it is. baseUpdatedAt is the updatedAt you read: when the profile changed since, the update fails with conflict naming when.',
  requires: 'content:write',
  input: PersonInput.extend({ personId: z.string().guid(), baseUpdatedAt: BaseUpdatedAt }),
  output: Person,
  examples: [
    {
      input: {
        personId: exampleId(1),
        baseUpdatedAt: '2026-11-01T09:00:00.000Z',
        name: 'Sam de Vries',
      },
    },
  ],
  handler: (ctx, { personId, baseUpdatedAt, ...fields }) =>
    updateEntity(ctx, ctx.authors, 'person', personId, baseUpdatedAt, (current, updatedAt) => ({
      ...fields,
      id: current.id,
      slug: current.slug,
      createdAt: current.createdAt,
      updatedAt,
    })),
});

export const getPerson = defineUseCase({
  name: 'content.person.get',
  kind: 'query',
  description: 'Get a person profile, including its internal e-mail address.',
  requires: 'content:read',
  input: z.object({ personId: z.string().guid() }),
  output: Person,
  examples: [{ input: { personId: exampleId(1) } }],
  async handler(ctx, { personId }) {
    return (await ctx.authors.get(personId)) ?? Promise.reject(notFound('person'));
  },
});

export const listPeople = defineUseCase({
  name: 'content.person.list',
  kind: 'query',
  description: 'List person profiles newest first, a page at a time.',
  requires: 'content:read',
  input: z.object({ after: z.string().guid().optional(), limit: Limit }),
  output: z.object({ people: z.array(Person), next: z.string().guid().nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { after, limit }) {
    const page = await ctx.authors.list(after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { people: page.rows, next: page.next };
  },
});

export const createSection = defineUseCase({
  name: 'content.section.create',
  kind: 'command',
  description: 'Create a section that articles can belong to, with its own archive page later.',
  requires: 'content:write',
  consumes: null,
  input: SectionInput.extend({ slug: Slug }),
  output: Section,
  examples: [{ input: { slug: 'politiek', title: { nl: 'Politiek', en: 'Politics' } } }],
  async handler(ctx, { slug, ...fields }) {
    await assertFreeSlug(ctx.sections, slug, 'a section');
    const now = stamp(ctx);
    const section: Section = {
      ...fields,
      id: ctx.ids.next(),
      slug,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await ctx.sections.insert(section))) throw slugTaken('a section', slug);
    return section;
  },
});

export const updateSection = defineUseCase({
  name: 'content.section.update',
  kind: 'command',
  description:
    'Replace the title, description and order of a section; the slug stays as it is. baseUpdatedAt is the updatedAt you read: when the section changed since, the update fails with conflict naming when.',
  requires: 'content:write',
  input: SectionInput.extend({ sectionId: z.string().guid(), baseUpdatedAt: BaseUpdatedAt }),
  output: Section,
  examples: [
    {
      input: {
        sectionId: exampleId(1),
        baseUpdatedAt: '2026-11-01T09:00:00.000Z',
        title: { nl: 'Politiek' },
      },
    },
  ],
  handler: (ctx, { sectionId, baseUpdatedAt, ...fields }) =>
    updateEntity(ctx, ctx.sections, 'section', sectionId, baseUpdatedAt, (current, updatedAt) => ({
      ...fields,
      id: current.id,
      slug: current.slug,
      createdAt: current.createdAt,
      updatedAt,
    })),
});

export const getSection = defineUseCase({
  name: 'content.section.get',
  kind: 'query',
  description: 'Get a section.',
  requires: 'content:read',
  input: z.object({ sectionId: z.string().guid() }),
  output: Section,
  examples: [{ input: { sectionId: exampleId(1) } }],
  async handler(ctx, { sectionId }) {
    return (await ctx.sections.get(sectionId)) ?? Promise.reject(notFound('section'));
  },
});

export const listSections = defineUseCase({
  name: 'content.section.list',
  kind: 'query',
  description: 'List sections newest first, a page at a time.',
  requires: 'content:read',
  input: z.object({ after: z.string().guid().optional(), limit: Limit }),
  output: z.object({ sections: z.array(Section), next: z.string().guid().nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { after, limit }) {
    const page = await ctx.sections.list(after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { sections: page.rows, next: page.next };
  },
});

/** A pattern's blocks as stored: ids assigned, and every block type switched on for the site. */
function withIds(ctx: TransactionContext, blocks: readonly BlockInput[]) {
  requireBlockTypes(ctx, blocks);
  return assignBlockIds(blocks, () => ctx.ids.next());
}

/**
 * Patterns protect their media like revisions do, under `pattern:<id>` with the pattern's own
 * block ids (docs/reference/media.md § Usages). A pattern write takes the media lock before it
 * reads anything, so the row and its usages always come from the same write, and a delete of an
 * image it uses waits or refuses. The references are checked like a document's.
 */
async function savePatternBlocks(
  ctx: TransactionContext,
  given: Pattern,
  write: (pattern: Pattern) => Promise<void>
): Promise<Pattern> {
  // ADR 034 rule 4: a pattern stores no name beside an erased person's credit (N1 of the merge
  // review); the reference check lets the registered id through (rule 7).
  const pattern = { ...given, blocks: await withoutErasedCredits(ctx, given.blocks) };
  const issues = await blockReferenceIssues(ctx, pattern.blocks);
  if (issues.length)
    throw new UseCaseError('invalid_input', 'the pattern references unknown data', issues);
  await write(pattern);
  await recordMediaUsages(ctx, `pattern:${pattern.id}`, pattern.blocks, []);
  return pattern;
}

export const createPattern = defineUseCase({
  name: 'content.pattern.create',
  kind: 'command',
  description: 'Save a block tree as a pattern that new pages or articles can start from.',
  requires: 'content:write',
  consumes: null,
  input: PatternInput,
  output: Pattern,
  examples: [
    {
      input: {
        name: { nl: 'Interview', en: 'Interview' },
        intendedType: 'article',
        blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Vraag één' } } }],
      },
    },
  ],
  async handler(ctx, { blocks, ...fields }) {
    await ctx.media.lock();
    const now = stamp(ctx);
    const pattern: Pattern = {
      ...fields,
      id: ctx.ids.next(),
      blocks: withIds(ctx, blocks),
      createdAt: now,
      updatedAt: now,
    };
    return savePatternBlocks(ctx, pattern, (p) => ctx.patterns.insert(p));
  },
});

export const updatePattern = defineUseCase({
  name: 'content.pattern.update',
  kind: 'command',
  description: 'Replace a pattern; documents created from it earlier keep their own copy.',
  requires: 'content:write',
  input: PatternInput.extend({ patternId: z.string().guid() }),
  output: Pattern,
  examples: [
    {
      input: {
        patternId: exampleId(1),
        name: { nl: 'Interview' },
        intendedType: 'article',
        blocks: [],
      },
    },
  ],
  async handler(ctx, { patternId, blocks, ...fields }) {
    // Lock before reading, so the pattern read here is the one whose usages get replaced.
    await ctx.media.lock();
    const current = await ctx.patterns.get(patternId);
    if (!current) throw notFound('pattern');
    const pattern: Pattern = {
      ...fields,
      id: current.id,
      blocks: withIds(ctx, blocks),
      createdAt: current.createdAt,
      updatedAt: stamp(ctx),
    };
    return savePatternBlocks(ctx, pattern, (p) => ctx.patterns.update(p));
  },
});

export const getPattern = defineUseCase({
  name: 'content.pattern.get',
  kind: 'query',
  description: 'Get a pattern with its block tree.',
  requires: 'content:read',
  input: z.object({ patternId: z.string().guid() }),
  output: Pattern,
  examples: [{ input: { patternId: exampleId(1) } }],
  async handler(ctx, { patternId }) {
    return (await ctx.patterns.get(patternId)) ?? Promise.reject(notFound('pattern'));
  },
});

export const listPatterns = defineUseCase({
  name: 'content.pattern.list',
  kind: 'query',
  description: 'List patterns newest first, a page at a time.',
  requires: 'content:read',
  input: z.object({ after: z.string().guid().optional(), limit: Limit }),
  output: z.object({ patterns: z.array(Pattern), next: z.string().guid().nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { after, limit }) {
    const page = await ctx.patterns.list(after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { patterns: page.rows, next: page.next };
  },
});
