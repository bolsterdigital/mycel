// Access tiers for the admin (ADR 016 rule 2): the tier screen and the tier choice on an item's
// edit screen read the same list, through the registry and under the operator's own principal,
// so a tier of another tenant can never be listed or chosen. The form edits one content locale
// and keeps the others, like a person's or a group's.
// Rejected: reading only the first page (a site with many tiers would silently lose the older
// ones as a choice, and a save would then drop them from the item).
import {
  pickAny,
  slugFromTitle,
  useCases,
  type AccessTier,
  type Invoker,
  type Principal,
} from '@mycel/core';
import { text } from '../admin/admin-actions.js';
import { runtime } from '../runtime.js';

/** Every tier of the principal's tenant, in display order, then by slug. */
export async function tierDirectory(
  principal: Principal,
  invoker: Invoker = runtime().invoker
): Promise<AccessTier[]> {
  const tiers: AccessTier[] = [];
  let after: string | undefined;
  do {
    const page = await invoker.run(useCases.listAccessTiers, principal, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    tiers.push(...page.tiers);
    after = page.next ?? undefined;
  } while (after);
  return tiers.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** The tiers an item can be for, named in `locale` (the slug where a tier has no name there). */
export async function tierChoices(principal: Principal, locale: string, invoker?: Invoker) {
  return (await tierDirectory(principal, invoker)).map((tier) => ({
    id: tier.id,
    name: pickAny(tier.name, locale) ?? tier.slug,
  }));
}

function localizedEdit(
  previous: Partial<Record<string, string>> | undefined,
  locale: string,
  value: string
) {
  const next: Record<string, string> = {};
  for (const [l, v] of Object.entries(previous ?? {})) if (v !== undefined) next[l] = v;
  if (value.trim()) next[locale] = value.trim();
  else delete next[locale];
  return next;
}

/** What a tier form changes: name, description and order, in the content locale shown. */
export function tierFields(data: FormData, locale: string, current?: AccessTier) {
  const description = localizedEdit(current?.description, locale, text(data, 'description'));
  return {
    name: localizedEdit(current?.name, locale, text(data, 'name')),
    ...(Object.keys(description).length ? { description } : {}),
    order: Number(text(data, 'order') || 0),
  };
}

/** What only a new tier takes: its slug (from the name when left empty) and its kind. */
export function newTierFields(data: FormData) {
  return {
    slug: text(data, 'slug').trim() || slugFromTitle(text(data, 'name')),
    kind: text(data, 'kind') === 'paid' ? ('paid' as const) : ('free' as const),
  };
}
