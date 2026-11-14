// Where the draft shows its menus (ADR 036 rule 4), as the placements form posts it: one menu for
// the main navigation with the top-level items that may stand in the bar, an optional menu of at
// most two calls to action, up to four footer columns with an optional title, and an optional
// legal menu. Pure, so the route saves the result on the revision the editor read and core merges
// it per placement (ADR 026) and checks the rules (`navigationIssues`).
//
// The bar is chosen per item of the menu that is placed now: a form without JavaScript cannot
// show the items of a menu the editor has only just selected, so a new main menu starts with all
// its top-level items in the bar (as the migration of rule 10 does) and is narrowed after saving.
// A footer column keeps its title in other locales while it shows the same menu.
// Rejected: a per-placement order or label (rule 4 forbids a hidden override), and a reorder step
// per footer column (four numbered slots say the order without a second kind of control).

import type { NavigationDocument, Placements } from '@mycel/core';

export const FOOTER_SLOTS = 4;

/** What the placements form posted; an empty menu id is "none". */
export interface PlacementsForm {
  main: string;
  /** The top-level ids ticked for the bar, or null when the form showed no bar choice. */
  bar: string[] | null;
  actions: string;
  /** The footer slots in order, empty ones included. */
  footer: { menuId: string; title: string }[];
  legal: string;
}

/** The form fields of `placements`, for a form that shows them again. */
export function formOf(placements: Placements, locale: string): PlacementsForm {
  const { main, actions, footer, legal } = placements;
  return {
    main: main?.menuId ?? '',
    bar: main?.bar ?? null,
    actions: actions?.menuId ?? '',
    footer: Array.from({ length: Math.max(FOOTER_SLOTS, footer.length) }, (_, i) => ({
      menuId: footer[i]?.menuId ?? '',
      title: footer[i]?.title?.[locale] ?? '',
    })),
    legal: legal?.menuId ?? '',
  };
}

/**
 * The placements `form` asks for on `doc`, with the titles in `locale`; null when it names a menu
 * the document does not have (removed since the form was loaded).
 */
export function placementsFrom(
  doc: NavigationDocument,
  form: PlacementsForm,
  locale: string
): Placements | null {
  const menu = (id: string) => doc.menus.find((m) => m.id === id);
  const named = [form.main, form.actions, form.legal, ...form.footer.map((f) => f.menuId)];
  if (named.some((id) => id && !menu(id))) return null;
  const was = doc.placements;

  let main: Placements['main'] = null;
  if (form.main) {
    const top = menu(form.main)!.nodes.map((n) => n.id);
    const ticked = form.main === was.main?.menuId && form.bar ? new Set(form.bar) : null;
    main = { menuId: form.main, bar: ticked ? top.filter((id) => ticked.has(id)) : top };
  }
  const footer = form.footer.flatMap((slot, i) => {
    if (!slot.menuId) return [];
    const before = was.footer[i]?.menuId === slot.menuId ? was.footer[i]?.title : undefined;
    const { [locale]: _old, ...rest } = before ?? {};
    const title = slot.title.trim() ? { ...rest, [locale]: slot.title.trim().slice(0, 120) } : rest;
    return [{ menuId: slot.menuId, ...(Object.keys(title).length ? { title } : {}) }];
  });
  return {
    main,
    actions: form.actions ? { menuId: form.actions } : null,
    footer,
    legal: form.legal ? { menuId: form.legal } : null,
  };
}
