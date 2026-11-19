// What the edit screen's dossier picker and an overview's dossier filter offer (MY-260): the
// site's dossier pages, by title in the content locale, and apart from them the ids an item still
// names that are no dossier any more (in the trash or gone). Those cannot be chosen again, and the
// picker shows them with a remove button, because core refuses every save that still names one
// (`content.dossier.not-a-dossier`) and the editor would otherwise be stuck.
// Rejected: dropping such an id on every save without a word (a restored dossier would come back
// without its members, and nobody would know why), and the button target's search route, which
// finds every page and article (a dossier is one profile among them).
import {
  MAX_PAGE_SIZE,
  isUuid,
  pickAny,
  useCases,
  type ContentDocument,
  type Principal,
} from '@mycel/core';
import { orNull } from '../admin/admin-actions.js';
import { runtime } from '../runtime.js';

export interface DossierOption {
  id: string;
  label: string;
}

export interface DossierChoices {
  /** The site's dossier pages, outside the trash. */
  available: DossierOption[];
  /** Chosen ids that are no dossier page now, in the order they were chosen. */
  unavailable: DossierOption[];
}

/** The dossier pages of the site, and which of `chosen` are not among them. */
export async function dossierChoices(
  principal: Principal,
  locale: string,
  chosen: readonly string[]
): Promise<DossierChoices> {
  const { items } = await runtime().invoker.run(useCases.listItems, principal, {
    type: 'page',
    profile: 'dossier',
    limit: MAX_PAGE_SIZE,
  });
  const label = (i: { title: Record<string, string | undefined>; slug: string }) =>
    pickAny(i.title, locale) ?? i.slug;
  const available = items.map((i) => ({ id: i.id, label: label(i) }));
  const unavailable: DossierOption[] = [];
  const known = new Set(available.map((d) => d.id));
  // A chosen dossier past the first page is still one; anything else is named by its title while
  // it can be read, by the start of its id after that.
  for (const id of new Set(chosen)) {
    if (known.has(id)) continue;
    const got = isUuid(id)
      ? await orNull(runtime().invoker.run(useCases.getItem, principal, { itemId: id }))
      : null;
    if (got?.item.profile === 'dossier') available.push({ id, label: label(got.item) });
    else unavailable.push({ id, label: got ? label(got.item) : id.slice(0, 8) });
  }
  return { available, unavailable };
}

/**
 * The picker of an item that can belong to a dossier (an article, an ordinary page or an event),
 * with `chosen` as posted or else as stored; null for a dossier, which names none, and a zone,
 * which is only ever shown inside other pages.
 */
export async function dossiersOf(
  principal: Principal,
  locale: string,
  doc: ContentDocument,
  chosen: unknown = (doc.dossiers ?? []).map((d) => d.itemId)
): Promise<DossierChoices | null> {
  if (doc.type === 'page' && doc.profile && doc.profile !== 'event') return null;
  return dossierChoices(principal, locale, Array.isArray(chosen) ? chosen : []);
}
