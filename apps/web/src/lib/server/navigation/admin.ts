// The menu editor's server side (ADR 036, brief site-navigation § 3): every step of the editor is
// one save of the whole navigation document on the revision the editor read. The step is applied
// to that revision's document, not to the latest, so core sees what this editor changed and
// merges it with what was saved since (ADR 026): two editors on different menus or nodes both
// keep their work, and the same order or label changed twice is refused as a conflict.
// A save is a draft; nothing reaches the site until a locale is published.
// Rejected: applying the step to the latest document (a stale tab would silently overwrite the
// other editor's label), and one big form per menu saved at the end (without JavaScript every
// move would have to re-render a hundred half-edited rows, as the block rows do, for a list whose
// steps are each complete on their own).

import {
  NavigationTarget,
  MAX_PAGE_SIZE,
  useCases,
  type Menu,
  type NavigationChild,
  type NavigationDocument,
  type NavigationNode,
  type NodeCheck,
  type Principal,
} from '@mycel/core';
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { movesOf, type Move } from '#lib/admin/navigation/menu-edit.js';
import { failureOf, text, type ActionCopy } from '../admin/admin-actions.js';
import { requireTenantPrincipal } from '../admin/admin.js';
import { withAssigned } from '../content/content-admin.js';
import { itemLabel } from '../content/content-blocks.js';
import { contentLocale } from '../content/content-locale.js';
import { refusalOf } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import type { UiKey } from '../../../i18n/index.js';

type AnyNode = NavigationNode | NavigationChild;

/** The sentences for what core refuses; anything else is the general "not saved". */
const COPY: ActionCopy = {
  conflict: 'admin.navigation.error.conflict',
  invalid: 'admin.navigation.error.invalid',
  notFound: 'admin.navigation.error.conflict',
  issues: {
    'site.navigation.target.unknown': 'admin.navigation.error.targetGone',
    'site.navigation.menu.published': 'admin.navigation.error.menuPublished',
    'site.navigation.budget.menus': 'admin.navigation.error.budget',
    'site.navigation.budget.nodes': 'admin.navigation.error.budget',
    'site.navigation.budget.site': 'admin.navigation.error.budget',
    'site.navigation.placement.actions': 'admin.navigation.error.actions',
  },
};

/** What the form posted, to show it again after a refusal. */
const posted = (data: FormData): Record<string, string> =>
  Object.fromEntries([...data].flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));

/** An id for a new menu or node: within core's alphabet, and unique without a lookup. */
export const newId = (): string => crypto.randomUUID();

/**
 * Run one step of the editor and save it. `step` gets the document the editor read and gives the
 * next one, or the catalog key of why it cannot; `to` names the page to show after, below the
 * navigation screen. A refusal comes back as a form failure with what was posted.
 */
export async function saveNavigation(
  event: RequestEvent,
  action: string,
  step: (
    document: NavigationDocument,
    data: FormData,
    locale: string
  ) => NavigationDocument | UiKey,
  to: (data: FormData) => string
) {
  const { principal, tenant } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params['tenant']!
  );
  const data = await event.request.formData();
  const seen = text(data, 'baseRevisionId') || null;
  const { invoker } = runtime();
  let merged = false;
  try {
    // An editor who saw no navigation at all has no revision to merge from: their step goes on
    // what is there now, so the site's first two menus can be made in two windows at once.
    const { document, revisionId } = await invoker.run(
      useCases.getNavigation,
      principal,
      seen ? { revisionId: seen } : {}
    );
    const next = step(document, data, contentLocale(event.cookies, tenant));
    if (typeof next === 'string') return fail(400, { action, error: next, values: posted(data) });
    ({ merged } = await invoker.run(useCases.updateNavigation, principal, {
      baseRevisionId: seen ?? revisionId,
      document: next,
    }));
  } catch (e) {
    const { status, body } = failureOf(refusalOf(e), action, COPY);
    return fail(status, { ...body, values: posted(data) });
  }
  const path = to(data);
  redirect(303, `/admin/${tenant.slug}/navigation${path}?${merged ? 'merged' : 'saved'}=1`);
}

/** A label with `value` as its text in `locale`, or without that locale when `value` is empty. */
function withLabel(
  label: Record<string, string> | undefined,
  locale: string,
  value: string
): Record<string, string> {
  const { [locale]: _old, ...rest } = label ?? {};
  return value ? { ...rest, [locale]: value } : rest;
}

/**
 * The node a form describes: a group with its label, or a link to a page or article, an address,
 * the home page or the search page, with an optional text of its own in `locale`. Other locales
 * keep their text, a node keeps its sub-items, and an anchor stays while the target does. A group
 * and an address have no title to inherit, so they need their own text.
 */
export function nodeFromForm(
  data: FormData,
  locale: string,
  kind: 'link' | 'group',
  id: string,
  current: AnyNode | null
): AnyNode | UiKey {
  const own = text(data, 'label').trim().slice(0, 120);
  const label = withLabel(current?.label, locale, own);
  if (kind === 'group') {
    if (!own) return 'admin.navigation.error.labelRequired';
    return { id, kind, label, children: current?.kind === 'group' ? current.children : [] };
  }
  const choice = text(data, 'target');
  const was = current?.kind === 'link' ? current.target : null;
  const target = NavigationTarget.safeParse(
    choice === 'url' || (!choice && text(data, 'url').trim())
      ? { kind: 'url', href: text(data, 'url').trim() }
      : choice === 'home' || choice === 'search'
        ? { kind: 'system', page: choice }
        : {
            kind: 'content',
            itemId: choice,
            ...(was?.kind === 'content' && was.itemId === choice && was.anchor
              ? { anchor: was.anchor }
              : {}),
          }
  );
  if (!target.success)
    return choice === 'url' || !choice
      ? 'admin.navigation.error.address'
      : 'admin.navigation.error.targetRequired';
  if (target.data.kind === 'url' && !own) return 'admin.navigation.error.labelRequired';
  const children = current && 'children' in current ? current.children : undefined;
  return {
    id,
    kind,
    target: target.data,
    ...(Object.keys(label).length ? { label } : {}),
    ...(children?.length ? { children } : {}),
  };
}

export interface TargetOption {
  id: string;
  label: string;
}

/**
 * The pages and articles a link can target: the newest hundred, plus every one the menus already
 * use (an older page stays named), each as the pickers of the edit screen name it. An item that
 * is gone is named by its id, so its row still says what it pointed at.
 */
export async function targetItems(
  principal: Principal,
  used: readonly string[],
  locale: string
): Promise<TargetOption[]> {
  const { invoker } = runtime();
  const { items } = await invoker.run(useCases.listItems, principal, { limit: MAX_PAGE_SIZE });
  return withAssigned(
    [...new Set(used)],
    items.map((i) => ({ id: i.id, label: itemLabel(i, locale) })),
    async (itemId) => {
      const got = await invoker.run(useCases.getItem, principal, { itemId }).catch(() => null);
      return got && { id: got.item.id, label: itemLabel(got.item, locale) };
    },
    (id) => ({ id, label: id })
  );
}

export interface MenuRow {
  id: string;
  /** A sub-item of the top-level row above it. */
  child: boolean;
  kind: 'link' | 'group';
  /** What visitors read in the content locale; null when it has no text there. */
  label: string | null;
  source: NodeCheck['source'];
  /** A content target's state, or null. */
  state: NodeCheck['target'];
  /** Where a link leads: the page as a picker names it or the address in `text`, or a system page. */
  target: { kind: 'content' | 'url' | 'home' | 'search'; text: string } | null;
  moves: Move[];
  /** Its sub-items, for a top-level row. */
  children: MenuRow[];
}

/** The rows of a menu as the editor lists them: each node with what it shows and may do. */
export function menuRows(
  menu: Menu,
  checks: readonly NodeCheck[],
  items: readonly TargetOption[]
): MenuRow[] {
  const check = new Map(checks.filter((c) => c.menuId === menu.id).map((c) => [c.nodeId, c]));
  const named = new Map(items.map((i) => [i.id, i.label]));
  const row = (node: AnyNode, child: boolean): MenuRow => {
    const c = check.get(node.id);
    const t = node.kind === 'link' ? node.target : null;
    return {
      id: node.id,
      child,
      kind: node.kind,
      label: c?.label ?? null,
      source: c?.source ?? null,
      state: c?.target ?? null,
      target: !t
        ? null
        : t.kind === 'system'
          ? { kind: t.page, text: '' }
          : t.kind === 'url'
            ? { kind: 'url', text: t.href }
            : { kind: 'content', text: named.get(t.itemId) ?? t.itemId },
      moves: movesOf(menu, node.id),
      children: ('children' in node ? (node.children ?? []) : []).map((c) => row(c, true)),
    };
  };
  return menu.nodes.map((n) => row(n, false));
}
