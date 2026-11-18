// The words for one event on a supporter's page (brief MY-251 PR 2): the log stores a type and a
// reference, the administrator reads "Signed up for Newsletter" and "Signed Petition X". Each
// event type the platform writes today has its sentence in the catalogue, a gift with its amount;
// a type without one (a membership event of a backfill, a type of a newer release) shows its name,
// which says more than an empty row. Pure and client-safe, like ../audit-words.ts; rejected: the
// sentences in core (copy belongs in the web catalogue, ADR 007).

import type { TimelineEntry } from '@mycel/core';
import { en, type UiKey } from '../../../i18n/en.js';
import { fill } from '../../../i18n/index.js';
import { formatMoney } from '../../money.js';
import { perInterval } from '../donations/giving.js';

const has = (key: string): key is UiKey => key in en;

/** The names a page knows for what an event refers to, by id. */
export interface TimelineNames {
  lists: Readonly<Record<string, string>>;
  campaigns: Readonly<Record<string, string>>;
  tiers: Readonly<Record<string, string>>;
}

/** The sentence's key, or null when the catalogue has none and the type is all there is. */
export function eventKey(entry: Pick<TimelineEntry, 'type' | 'confirmed'>): UiKey | null {
  const key = `admin.supporter.event.${entry.type}`;
  const pending = `${key}.pending`;
  if (entry.confirmed === false && has(pending)) return pending;
  return has(key) ? key : null;
}

/** What the event was about, by name when the page knows it, else in general words. */
function subject(t: (key: UiKey) => string, entry: TimelineEntry, names: TimelineNames): string {
  if (entry.campaignId)
    return names.campaigns[entry.campaignId] ?? t('admin.supporter.some.campaign');
  if (entry.tierId) return names.tiers[entry.tierId] ?? t('admin.supporter.some.tier');
  if (entry.list) return names.lists[entry.list] ?? entry.list;
  if (entry.type.startsWith('access.')) return t('admin.supporter.some.tier');
  if (entry.type === 'petition.signed' || entry.type === 'form.submitted')
    return t('admin.supporter.some.campaign');
  return t('admin.supporter.some.list');
}

export function eventSentence(
  t: (key: UiKey) => string,
  entry: TimelineEntry,
  names: TimelineNames,
  locale = 'nl'
): string {
  const key = eventKey(entry);
  if (!key) return entry.type;
  // A gift reads by its amount ("Gaf € 25"), a recurring one per interval ("€ 10 per maand");
  // the page's locale formats it.
  if (entry.amount)
    return fill(t(key), {
      what: entry.interval
        ? perInterval(t, entry.amount.value, entry.amount.currency, entry.interval, locale)
        : formatMoney(entry.amount.value, entry.amount.currency, locale),
    });
  return fill(t(key), { what: subject(t, entry, names) });
}
