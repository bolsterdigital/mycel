// How a campaign's counter reads (ADR 033 rule 8), on the public card and in the admin alike: a
// petition or signup counts people as a plain number, a fundraiser counts money ("€ 1.250") and
// its goal is an amount in the same minor units. Client-safe. Rejected: formatting per screen,
// which let the card and the admin show one fundraiser as cents in one place and euros in another.
import type { CampaignKind } from '@mycel/core';
import { formatMoney } from './money.js';

/** What a campaign counts now, as core's view and card give it. */
export interface CampaignTally {
  participants: number;
  /** Set for a fundraiser: its paid gifts, in minor units. */
  raised: { amount: number; currency: string } | null;
}

export interface CountFigures {
  /** The number a bar measures against `target`, in the unit of the kind. */
  value: number;
  count: string;
  /** Null without a goal. */
  target: string | null;
}

export function countFigures(
  tally: CampaignTally,
  target: number | null,
  locale: string
): CountFigures {
  const { raised } = tally;
  const number = new Intl.NumberFormat(locale);
  const format = (n: number) =>
    raised ? formatMoney(n, raised.currency, locale) : number.format(n);
  const value = raised ? raised.amount : tally.participants;
  return { value, count: format(value), target: target === null ? null : format(target) };
}

/**
 * A goal as typed, in the unit of the kind: a fundraiser's in whole euros, stored in cents
 * (ADR 033 rule 8), a petition's or signup's in people. Null for empty, NaN for not a whole number.
 */
export function goalTarget(typed: string, kind: CampaignKind): number | null {
  const value = typed.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return NaN;
  return kind === 'fundraiser' ? n * 100 : n;
}

/** The goal as the field shows it: whole euros for a fundraiser. */
export const goalInput = (target: number | null, kind: CampaignKind): string =>
  target === null ? '' : String(kind === 'fundraiser' ? Math.round(target / 100) : target);
