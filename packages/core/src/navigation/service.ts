// The use cases of site navigation (ADR 036 rule 7): read and save the draft, publish and
// unpublish one locale, restore an older revision as a new draft, and the public read. Writing
// and restoring need `content:write`; publishing a locale and taking it offline need
// `content:publish`, the same split as content (ADR 018 rule 5). MCP and the API expose the same
// use cases with the same capabilities.
//
// A save carries `baseRevisionId`. On an older base the caller's document is merged with what was
// saved since (ADR 026, `mergeDocuments`): per menu, per node and per placement, so only the
// same menu's order, the same label or the same placement conflicts. Every write takes the
// navigation lock first, before any content read, which is the lock order `content.item.delete`
// keeps (rule 9). Rejected: a version number like `site.chrome.update` (a second editor's save on
// another menu would be refused), and a lock per menu (a placement and its menu would no longer
// change together).

import { z } from 'zod';
import { UseCaseError, notFound, type Issue } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { canonicalJson } from '../util/canonical-json.js';
import { exampleId } from '../util/ids.js';
import { mergeDocuments } from '../content/merge/merge.js';
import { mergeConflict } from '../content/merge/save.js';
import {
  EMPTY_NAVIGATION,
  NavigationDocument,
  menuNodes,
  navigationIssues,
  navigationReferences,
} from './model.js';
import { checkNavigation, targetIds } from './check.js';
import type { NavigationHead, NavigationRevision } from './ports.js';
import {
  BLOCKING_PROBLEMS,
  placedTargetIds,
  resolveNavigation,
  type NavigationProblem,
} from './resolve.js';
import './ports.js';

const RevisionId = z.string().guid();
const IsoDate = z.string().datetime({ offset: true });
const REVISIONS_SHOWN = 20;

const RevisionSummary = z.object({
  id: RevisionId,
  createdAt: IsoDate,
  baseRevisionId: RevisionId.nullable(),
  merged: z.boolean(),
  restoredFrom: RevisionId.nullable(),
});

const NavigationState = z.object({
  /** Null until the first save; `document` is then the empty navigation. */
  revisionId: RevisionId.nullable(),
  document: NavigationDocument,
  updatedAt: IsoDate.nullable(),
  publication: z.array(z.object({ locale: Locale, revisionId: RevisionId, publishedAt: IsoDate })),
  revisions: z.array(RevisionSummary),
});
type NavigationState = z.infer<typeof NavigationState>;

const SaveResult = NavigationState.extend({
  /** The save was on an older base and merged with what was saved since (ADR 026). */
  merged: z.boolean(),
});

const exampleDocument: z.input<typeof NavigationDocument> = {
  menus: [
    {
      id: 'main',
      name: 'Main menu',
      nodes: [
        { id: 'home', kind: 'link', target: { kind: 'system', page: 'home' } },
        {
          id: 'about',
          kind: 'link',
          label: { nl: 'Over ons', en: 'About us' },
          target: { kind: 'url', href: '/over-ons' },
        },
      ],
    },
  ],
  placements: {
    main: { menuId: 'main', bar: ['home', 'about'] },
    actions: null,
    footer: [],
    legal: null,
  },
};

const iso = (d: Date) => d.toISOString();

async function state(
  ctx: TransactionContext,
  head: NavigationHead | null
): Promise<NavigationState> {
  if (!head)
    return {
      revisionId: null,
      document: EMPTY_NAVIGATION,
      updatedAt: null,
      publication: [],
      revisions: [],
    };
  const latest = await ctx.navigation.revision(head.latestRevisionId);
  if (!latest) throw notFound('navigation revision');
  const revisions = await ctx.navigation.revisions(REVISIONS_SHOWN);
  return {
    revisionId: latest.id,
    document: latest.document,
    updatedAt: iso(head.updatedAt),
    publication: head.publication.map((p) => ({
      locale: p.locale,
      revisionId: p.revisionId,
      publishedAt: iso(p.publishedAt),
    })),
    revisions: revisions.map((r) => ({
      id: r.id,
      createdAt: iso(r.createdAt),
      baseRevisionId: r.baseRevisionId,
      merged: r.merged,
      restoredFrom: r.restoredFrom,
    })),
  };
}

function refuse(issues: Issue[]): never {
  throw new UseCaseError(
    'invalid_input',
    'the navigation is not valid',
    issues.map((i) => ({
      ...i,
      path: i.path ? `document.${i.path}` : 'document',
    }))
  );
}

/**
 * A content target the latest revision does not already have must exist outside the trash: a
 * new link to an unknown or deleted item is refused. One that was already there may stay (a
 * restore brings back what it had, rule 9); it shows nothing publicly until it is fixed.
 */
async function checkNewTargets(
  ctx: TransactionContext,
  next: NavigationDocument,
  latest: NavigationDocument | null
): Promise<void> {
  const before = new Set((latest ? navigationReferences(latest) : []).map((r) => r.itemId));
  const added = [...new Set(navigationReferences(next).map((r) => r.itemId))].filter(
    (id) => !before.has(id)
  );
  if (!added.length) return;
  const existing = await ctx.navigation.existingItems(added);
  const issues: Issue[] = [];
  next.menus.forEach((menu, m) =>
    menu.nodes.forEach((node, n) =>
      [node, ...(node.children ?? [])].forEach((x, k) => {
        if (x.kind !== 'link' || x.target.kind !== 'content') return;
        if (!added.includes(x.target.itemId) || existing.has(x.target.itemId)) return;
        const path =
          x === node ? `menus.${m}.nodes.${n}` : `menus.${m}.nodes.${n}.children.${k - 1}`;
        issues.push({
          path: `${path}.target.itemId`,
          message: 'site.navigation.target.unknown',
          params: { itemId: x.target.itemId },
        });
      })
    )
  );
  if (issues.length) refuse(issues);
}

/**
 * Rule 9: a menu that a placement of a published revision uses cannot be removed from the draft;
 * take the placement offline first. The draft's own placements are checked by `navigationIssues`.
 */
async function checkRemovedMenus(
  ctx: TransactionContext,
  next: NavigationDocument,
  head: NavigationHead | null
): Promise<void> {
  if (!head) return;
  const kept = new Set(next.menus.map((m) => m.id));
  const issues: Issue[] = [];
  for (const id of new Set(head.publication.map((p) => p.revisionId))) {
    const published = await ctx.navigation.revision(id);
    if (!published) continue;
    const { main, actions, footer, legal } = published.document.placements;
    for (const menuId of [
      main?.menuId,
      actions?.menuId,
      ...footer.map((f) => f.menuId),
      legal?.menuId,
    ])
      if (menuId && !kept.has(menuId) && !issues.some((i) => i.params?.['menuId'] === menuId))
        issues.push({
          path: 'menus',
          message: 'site.navigation.menu.published',
          params: { menuId },
        });
  }
  if (issues.length) refuse(issues);
}

/** Validate, check references and store `document` as the new latest revision. */
async function store(
  ctx: TransactionContext,
  head: NavigationHead | null,
  latest: NavigationRevision | null,
  revision: Omit<NavigationRevision, 'id' | 'createdAt'>
): Promise<NavigationRevision> {
  const issues = navigationIssues(revision.document);
  if (issues.length) refuse(issues);
  if (!revision.restoredFrom)
    await checkNewTargets(ctx, revision.document, latest?.document ?? null);
  await checkRemovedMenus(ctx, revision.document, head);
  const stored: NavigationRevision = {
    ...revision,
    id: ctx.ids.next(),
    createdAt: ctx.clock.now(),
  };
  await ctx.navigation.insertRevision(stored);
  return stored;
}

async function lockedHead(ctx: TransactionContext) {
  await ctx.navigation.lock('exclusive');
  const head = await ctx.navigation.head();
  const latest = head ? await ctx.navigation.revision(head.latestRevisionId) : null;
  if (head && !latest) throw notFound('navigation revision');
  return { head, latest };
}

export const getNavigation = defineUseCase({
  name: 'site.navigation.get',
  kind: 'query',
  description:
    'Read the latest navigation draft (every menu and placement), which revision each locale publishes, and the newest revisions. With `revisionId`, `document` is that revision instead: what an editor saw when they started, or an older one before restoring it.',
  requires: 'content:read',
  input: z.object({ revisionId: RevisionId.optional() }).strict(),
  output: NavigationState,
  examples: [{ input: {} }],
  async handler(ctx, { revisionId }) {
    const latest = await state(ctx, await ctx.navigation.head());
    if (!revisionId || revisionId === latest.revisionId) return latest;
    const revision = await ctx.navigation.revision(revisionId);
    if (!revision) throw notFound('navigation revision');
    return { ...latest, revisionId: revision.id, document: revision.document };
  },
});

export const updateNavigation = defineUseCase({
  name: 'site.navigation.update',
  kind: 'command',
  description:
    'Save the navigation as a new draft revision on the revision you read (null before the first save). On an older base it merges per menu, node and placement; the same value changed on both sides is a conflict. Nothing goes live until a locale is published.',
  requires: 'content:write',
  input: z.object({ baseRevisionId: RevisionId.nullable(), document: NavigationDocument }).strict(),
  output: SaveResult,
  examples: [{ input: { baseRevisionId: null, document: exampleDocument } }],
  async handler(ctx, { baseRevisionId, document }) {
    const { head, latest } = await lockedHead(ctx);
    let next = document;
    let merged = false;
    if ((latest?.id ?? null) !== baseRevisionId) {
      const base = baseRevisionId ? await ctx.navigation.revision(baseRevisionId) : null;
      if (!base || !latest)
        throw new UseCaseError(
          'conflict',
          'the navigation has a newer revision than baseRevisionId',
          [
            {
              path: 'baseRevisionId',
              message: 'site.navigation.revision.conflict',
              params: { latestRevisionId: latest?.id ?? '' },
            },
          ]
        );
      const result = mergeDocuments(base.document, document, latest.document);
      if (result.conflicts.length) throw mergeConflict(latest.id, result.conflicts);
      const parsed = NavigationDocument.safeParse(result.document);
      if (!parsed.success) throw mergeConflict(latest.id, [{ path: '' }]);
      next = parsed.data;
      merged = true;
    }
    // A save that changes nothing writes nothing: a retry, or a merge that adds nothing.
    if (latest && canonicalJson(next) === canonicalJson(latest.document))
      return { ...(await state(ctx, head)), merged };
    await store(ctx, head, latest, {
      document: next,
      baseRevisionId,
      merged,
      restoredFrom: null,
    });
    return { ...(await state(ctx, await ctx.navigation.head())), merged };
  },
});

export const restoreNavigation = defineUseCase({
  name: 'site.navigation.restore',
  kind: 'command',
  description:
    'Copy an older navigation revision into a new draft on the revision you read. It goes live only when a locale is published again; a target that no longer exists shows as a problem until fixed.',
  requires: 'content:write',
  input: z.object({ revisionId: RevisionId, baseRevisionId: RevisionId }).strict(),
  output: NavigationState,
  examples: [{ input: { revisionId: exampleId(0x7a1), baseRevisionId: exampleId(0x7a2) } }],
  async handler(ctx, { revisionId, baseRevisionId }) {
    const { head, latest } = await lockedHead(ctx);
    if (!latest || latest.id !== baseRevisionId)
      throw new UseCaseError(
        'conflict',
        'the navigation has a newer revision than baseRevisionId',
        [
          {
            path: 'baseRevisionId',
            message: 'site.navigation.revision.conflict',
            params: { latestRevisionId: latest?.id ?? '' },
          },
        ]
      );
    const old = await ctx.navigation.revision(revisionId);
    if (!old) throw notFound('navigation revision');
    await store(ctx, head, latest, {
      document: old.document,
      baseRevisionId,
      merged: false,
      restoredFrom: old.id,
    });
    return state(ctx, await ctx.navigation.head());
  },
});

/** The problems of one revision in one locale, read as the public would resolve it. */
async function problemsOf(ctx: TransactionContext, document: NavigationDocument, locale: string) {
  const targets = await ctx.navigation.publishedTargets(placedTargetIds(document), locale);
  return resolveNavigation(document, locale, targets).problems;
}

const PublishInput = z.object({ revisionId: RevisionId, locale: Locale }).strict();

export const publishNavigation = defineUseCase({
  name: 'site.navigation.publish',
  kind: 'command',
  description:
    'Put one navigation revision live in one locale; other locales are untouched. Refused while a placed group or URL link has no label in that locale or a placed link targets an item that no longer exists. Returns what will not show publicly.',
  requires: 'content:publish',
  effect: 'publish',
  input: PublishInput,
  output: NavigationState.extend({
    problems: z.array(
      z.object({
        menuId: z.string(),
        nodeId: z.string(),
        code: z.enum([
          'label-missing',
          'target-unavailable',
          'children-unreachable',
          'anchor-missing',
        ]),
        children: z.array(z.string()).optional(),
      })
    ),
  }),
  examples: [{ input: { revisionId: exampleId(0x7a1), locale: 'nl' } }],
  async handler(ctx, { revisionId, locale }) {
    const { head } = await lockedHead(ctx);
    const revision = await ctx.navigation.revision(revisionId);
    if (!head || !revision) throw notFound('navigation revision');
    const doc = revision.document;
    const problems: NavigationProblem[] = await problemsOf(ctx, doc, locale);
    const issues: Issue[] = problems
      .filter((p) => BLOCKING_PROBLEMS.has(p.code))
      .map((p) => ({
        path: 'revisionId',
        message: `site.navigation.${p.code}`,
        params: { menuId: p.menuId, nodeId: p.nodeId, locale },
      }));
    // An item that no longer exists (deleted, or never was) is a broken menu, not an offline page.
    const ids = placedTargetIds(doc);
    const existing = ids.length ? await ctx.navigation.existingItems(ids) : new Set<string>();
    for (const menu of doc.menus)
      for (const node of menuNodes(menu))
        if (
          node.kind === 'link' &&
          node.target.kind === 'content' &&
          ids.includes(node.target.itemId) &&
          !existing.has(node.target.itemId)
        )
          issues.push({
            path: 'revisionId',
            message: 'site.navigation.target.unknown',
            params: { menuId: menu.id, nodeId: node.id, itemId: node.target.itemId },
          });
    if (issues.length)
      throw new UseCaseError(
        'invalid_input',
        `the navigation cannot be published in ${locale}`,
        issues
      );
    await ctx.navigation.publish(locale, revisionId, ctx.clock.now());
    return { ...(await state(ctx, await ctx.navigation.head())), problems };
  },
});

export const unpublishNavigation = defineUseCase({
  name: 'site.navigation.unpublish',
  kind: 'command',
  description:
    'Take the navigation offline in one locale: the site shows no menus there until it is published again.',
  requires: 'content:publish',
  effect: 'publish',
  input: z.object({ locale: Locale }).strict(),
  output: NavigationState,
  examples: [{ input: { locale: 'nl' } }],
  async handler(ctx, { locale }) {
    await ctx.navigation.lock('exclusive');
    if (!(await ctx.navigation.unpublish(locale)))
      throw notFound('published navigation', `locale "${locale}"`);
    return state(ctx, await ctx.navigation.head());
  },
});

export const checkNavigationUseCase = defineUseCase({
  name: 'site.navigation.check',
  kind: 'query',
  description:
    'What every node of the latest navigation draft (or of `revisionId`) would show visitors in one locale: its text, whether that is its own text or the published featured title or title of its target, and whether a content target is published publicly there. Covers every menu, placed or not.',
  requires: 'content:read',
  input: z.object({ locale: Locale, revisionId: RevisionId.optional() }).strict(),
  output: z.object({
    /** Null before the first save. */
    revisionId: RevisionId.nullable(),
    nodes: z.array(
      z.object({
        menuId: z.string(),
        nodeId: z.string(),
        label: z.string().nullable(),
        source: z.enum(['own', 'featured', 'title', 'system']).nullable(),
        target: z.enum(['ok', 'unpublished', 'restricted', 'missing']).nullable(),
      })
    ),
  }),
  examples: [{ input: { locale: 'nl' } }],
  async handler(ctx, { locale, revisionId }) {
    const id = revisionId ?? (await ctx.navigation.head())?.latestRevisionId;
    if (!id) return { revisionId: null, nodes: [] };
    const revision = await ctx.navigation.revision(id);
    if (!revision) throw notFound('navigation revision');
    const ids = targetIds(revision.document);
    const [targets, existing] = ids.length
      ? await Promise.all([
          ctx.navigation.publishedTargets(ids, locale),
          ctx.navigation.existingItems(ids),
        ])
      : [new Map(), new Set<string>()];
    return {
      revisionId: revision.id,
      nodes: checkNavigation(revision.document, locale, targets, existing),
    };
  },
});

const ResolvedTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('content'),
    itemId: z.string().guid(),
    type: z.enum(['page', 'article']),
    slug: z.string(),
    locale: Locale,
    anchor: z.string().optional(),
  }),
  z.object({ kind: z.literal('url'), href: z.string() }),
  z.object({ kind: z.literal('system'), page: z.enum(['home', 'search']) }),
]);
const ResolvedLink = z.object({
  id: z.string(),
  kind: z.literal('link'),
  label: z.string().nullable(),
  target: ResolvedTarget,
});
const ResolvedNode = z.discriminatedUnion('kind', [
  ResolvedLink.extend({ children: z.array(ResolvedLink) }),
  z.object({
    id: z.string(),
    kind: z.literal('group'),
    label: z.string(),
    children: z.array(ResolvedLink),
  }),
]);

export const resolveNavigationUseCase = defineUseCase({
  name: 'site.navigation.resolve',
  kind: 'query',
  description:
    'The published navigation of one locale as visitors see it: labels and targets of the placed menus, without anything that is offline, restricted or not published in that locale. Empty when the locale publishes no navigation.',
  requires: 'content:read',
  input: z.object({ locale: Locale }).strict(),
  output: z.object({
    revisionId: RevisionId.nullable(),
    main: z.object({ nodes: z.array(ResolvedNode), bar: z.array(z.string()) }).nullable(),
    actions: z.array(ResolvedLink),
    footer: z.array(z.object({ title: z.string().nullable(), nodes: z.array(ResolvedNode) })),
    legal: z.object({ nodes: z.array(ResolvedNode) }).nullable(),
  }),
  examples: [{ input: { locale: 'nl' } }],
  async handler(ctx, { locale }) {
    const empty = { revisionId: null, main: null, actions: [], footer: [], legal: null };
    const pointer = (await ctx.navigation.head())?.publication.find((p) => p.locale === locale);
    if (!pointer) return empty;
    const revision = await ctx.navigation.revision(pointer.revisionId);
    if (!revision) return empty;
    const targets = await ctx.navigation.publishedTargets(
      placedTargetIds(revision.document),
      locale
    );
    const { navigation } = resolveNavigation(revision.document, locale, targets);
    return { revisionId: revision.id, ...navigation };
  },
});
