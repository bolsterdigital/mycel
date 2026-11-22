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

/**
 * Milestones as typed (MY-288): whole numbers separated by commas or spaces, in the unit of the
 * kind as `goalTarget`. Empty for a fixed goal, null for anything that is not a list of whole
 * numbers; core refuses an order or a step above the goal with its own message.
 */
export function goalMilestones(typed: string, kind: CampaignKind): number[] | null {
  const parts = typed.split(/[\s,;]+/).filter(Boolean);
  const steps = parts.map((part) => goalTarget(part, kind));
  return steps.every((n) => typeof n === 'number' && Number.isInteger(n))
    ? (steps as number[])
    : null;
}

/** The milestones as the field shows them: whole euros for a fundraiser, comma-separated. */
export const milestonesInput = (milestones: readonly number[], kind: CampaignKind): string =>
  milestones.map((m) => goalInput(m, kind)).join(', ');

/**
 * A starting count as typed (MY-288 PR B): a whole number of people, empty for none. NaN for
 * anything else; core refuses one on a fundraiser, whose panel has no such field.
 */
export function startingCountOf(typed: string): number {
  const value = typed.trim();
  if (!value) return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}
