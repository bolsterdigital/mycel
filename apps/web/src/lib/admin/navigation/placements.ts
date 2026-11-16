// Where the draft shows its menus (ADR 036 rule 4), as the placements form posts it: one menu for
// the main navigation with the top-level items that may stand in the bar, an optional menu of at
// most two calls to action, up to four footer columns with an optional title, and an optional
// legal menu, and the zone shown above the footer. Pure, so the route saves the result on the revision the editor read and core merges
// it per placement (ADR 026) and checks the rules (`navigationIssues`).
//
// The bar is chosen per item of the menu that is placed now: a form without JavaScript cannot
// show the items of a menu the editor has only just selected, so a new main menu starts with all
// its top-level items in the bar (as the migration of rule 10 does) and is narrowed after saving.
// A footer column's titles in other locales follow its menu, also when it moves to another slot.
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
  /** The item id of the zone above the footer; empty is "none". */
  prefooter: string;
}

/** The form `fields` posted (each field as text), in the shape `placementsFrom` reads. */
export function postedForm(fields: Readonly<Record<string, string>>): PlacementsForm {
  const field = (key: string) => fields[key] ?? '';
  return {
    main: field('main'),
    bar: field('barShown')
      ? Object.keys(fields)
          .filter((k) => k.startsWith('bar:'))
          .map((k) => k.slice(4))
      : null,
    actions: field('actions'),
    footer: Array.from({ length: FOOTER_SLOTS }, (_, i) => ({
      menuId: field(`footer${i}`),
      title: field(`footer${i}Title`),
    })),
    legal: field('legal'),
    prefooter: field('prefooter'),
  };
}

/** One place where a refused form asked for something else than is saved now. */
export type Choice =
  | { place: 'main' | 'actions' | 'legal'; menuId: string }
  | { place: 'prefooter'; itemId: string }
  | { place: 'bar'; ids: string[] }
  | { place: 'footer'; slot: number; menuId: string; title: string };

/**
 * What `mine` (a form refused after a conflict) changed from `base` and still differs from
 * `saved` (the form as it is saved now), in the order of the form. After a conflict the fields show what is saved, so a
 * second Save cannot replace the other editor's choice unseen; these are what the editor redoes
 * by hand. The bar counts only for the main menu both forms show; empty is "none".
 */
export function changedChoices(
  mine: PlacementsForm,
  saved: PlacementsForm,
  base: PlacementsForm
): Choice[] {
  const changed = differences(mine, base);
  return differences(mine, saved).filter((choice) =>
    changed.some(
      (before) =>
        before.place === choice.place &&
        (before.place !== 'footer' || choice.place !== 'footer' || before.slot === choice.slot)
    )
  );
}

/** Differences per placement; bar membership is a set, footer titles ignore outer whitespace. */
function differences(mine: PlacementsForm, saved: PlacementsForm): Choice[] {
  const out: Choice[] = [];
  if (mine.main !== saved.main) out.push({ place: 'main', menuId: mine.main });
  const ticked = new Set(mine.bar ?? []);
  const was = new Set(saved.bar ?? []);
  if (
    mine.bar &&
    mine.main === saved.main &&
    (ticked.size !== was.size || [...ticked].some((id) => !was.has(id)))
  )
    out.push({ place: 'bar', ids: mine.bar });
  if (mine.actions !== saved.actions) out.push({ place: 'actions', menuId: mine.actions });
  mine.footer.forEach((slot, i) => {
    const now = saved.footer[i] ?? { menuId: '', title: '' };
    const title = slot.menuId ? slot.title.trim() : '';
    if (slot.menuId !== now.menuId || (slot.menuId && title !== now.title))
      out.push({ place: 'footer', slot: i + 1, menuId: slot.menuId, title });
  });
  if (mine.legal !== saved.legal) out.push({ place: 'legal', menuId: mine.legal });
  if (mine.prefooter !== saved.prefooter) out.push({ place: 'prefooter', itemId: mine.prefooter });
  return out;
}

/** The form fields of `placements`, for a form that shows them again. */
export function formOf(placements: Placements, locale: string): PlacementsForm {
  const { main, actions, footer, legal, prefooter } = placements;
  return {
    main: main?.menuId ?? '',
    bar: main?.bar ?? null,
    actions: actions?.menuId ?? '',
    footer: Array.from({ length: Math.max(FOOTER_SLOTS, footer.length) }, (_, i) => ({
      menuId: footer[i]?.menuId ?? '',
      title: footer[i]?.title?.[locale] ?? '',
    })),
    legal: legal?.menuId ?? '',
    prefooter: prefooter?.itemId ?? '',
  };
}

/**
 * Per slot of `form`, the column of `was` whose titles it keeps: the same slot while it shows the
 * same menu, else the first column of that menu that no slot kept, so a menu moved to another
 * slot takes its titles in other locales along. Undefined for a menu that was not in the footer.
 */
function columnSources(
  was: Placements['footer'],
  form: PlacementsForm['footer']
): (number | undefined)[] {
  const stays = form.map((slot, i) => !!slot.menuId && was[i]?.menuId === slot.menuId);
  const taken = new Set(stays.flatMap((s, i) => (s ? [i] : [])));
  return form.map((slot, i) => {
    if (stays[i]) return i;
    const j = was.findIndex((c, k) => c.menuId === slot.menuId && !taken.has(k));
    if (!slot.menuId || j < 0) return undefined;
    taken.add(j);
    return j;
  });
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
  const from = columnSources(was.footer, form.footer);
  const footer = form.footer.flatMap((slot, i) => {
    if (!slot.menuId) return [];
    const before = from[i] === undefined ? undefined : was.footer[from[i]]?.title;
    const { [locale]: _old, ...rest } = before ?? {};
    const title = slot.title.trim() ? { ...rest, [locale]: slot.title.trim().slice(0, 120) } : rest;
    return [{ menuId: slot.menuId, ...(Object.keys(title).length ? { title } : {}) }];
  });
  return {
    main,
    actions: form.actions ? { menuId: form.actions } : null,
    footer,
    legal: form.legal ? { menuId: form.legal } : null,
    // Core checks that it is a zone (`site.navigation.prefooter.not-a-zone`). A document that
    // never had one keeps no key, so saving it unchanged changes nothing.
    ...(form.prefooter
      ? { prefooter: { itemId: form.prefooter } }
      : was.prefooter !== undefined
        ? { prefooter: null }
        : {}),
  };
}
