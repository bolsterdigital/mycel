// A form edits one content locale, retaining the others from the version it is based on.
// Rejected: replacing localised maps with only the visible language, or losing input on failure.
import { slugFromTitle, type Person, type PersonGroup } from '@mycel/core';
import { placementFrom } from '../../admin/header-fields/placement-fields.js';
import { text } from '../admin/admin-actions.js';

export const fields = (data: FormData): Record<string, string> =>
  Object.fromEntries(
    [...data.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
function localizedEdit(
  previous: Record<string, string> | undefined,
  locale: string,
  value: string
) {
  const next = { ...previous };
  if (value.trim()) next[locale] = value.trim();
  else delete next[locale];
  return next;
}
export const personSlug = (data: FormData) =>
  text(data, 'slug').trim() || slugFromTitle(text(data, 'name'));
export function personFields(data: FormData, locale: string, current?: Person) {
  const optional = (key: string) => text(data, key).trim() || undefined;
  const links: Person['links'] = [];
  for (let i = 0; i < 12; i++) {
    const url = text(data, `link.${i}.url`).trim();
    const label = text(data, `link.${i}.label`).trim();
    if (url || (label && i > 1))
      links.push({
        url,
        label,
        kind: text(data, `link.${i}.kind`) as Person['links'][number]['kind'],
      });
  }
  const bio = localizedEdit(current?.bio, locale, text(data, 'bio'));
  // The kind is chosen once, by the create button; an update keeps the stored one. An
  // organisation's form has no role, phone or page fields, so nothing of them is posted.
  const kind: Person['kind'] =
    current?.kind ?? (text(data, 'kind') === 'organisation' ? 'organisation' : 'person');
  const imageId = optional('imageId');
  const placement =
    kind === 'person'
      ? placementFrom((key) => text(data, key), 'imagePlacement', imageId, current?.imagePlacement)
      : undefined;
  const role = kind === 'person' ? localizedEdit(current?.role, locale, text(data, 'role')) : {};
  return {
    kind,
    name: text(data, 'name').trim(),
    bio: Object.keys(bio).length ? bio : undefined,
    role: Object.keys(role).length ? role : undefined,
    organisation: optional('organisation'),
    publicEmail: optional('publicEmail'),
    email: optional('email'),
    phone: optional('phone'),
    imageId,
    ...(placement ? { imagePlacement: placement } : {}),
    pagePolicy: (text(data, 'pagePolicy') || 'auto') as Person['pagePolicy'],
    links,
  };
}
export function groupFields(data: FormData, locale: string, current?: PersonGroup) {
  // Explicit positions, rather than checkbox DOM order, retain or change membership order.
  const ids = data.getAll('personIds').map(String);
  const prior = current?.personIds ?? [];
  const ordered = [
    ...prior.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !prior.includes(id)),
  ];
  ordered.sort(
    (a, b) =>
      Number(text(data, `position.${a}`) || 10000) - Number(text(data, `position.${b}`) || 10000)
  );
  return {
    name: localizedEdit(current?.name, locale, text(data, 'name')),
    order: Number(text(data, 'order')),
    personIds: ordered,
  };
}
