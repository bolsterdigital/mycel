// What a form block shows of a gift's amount field (MY-252 PR 2, MY-254 PR 2): the presets as
// "€ 25", the label of an amount of one's own, and the question how often, each in the page's
// locale. And a membership form's prices (PR 4): "€ 5 per month" per interval the tier sells.
// Apart from resolve.ts, which is at its size ceiling; the field is the same data there.

import {
  CUSTOM_AMOUNT_CHOICE,
  customAmountName,
  pick,
  tierIntervals,
  translate,
  type FormField,
  type TierPrices,
} from '@mycel/core';
import { formatEuros } from '../money.js';
import type { RenderForm } from './model.js';

type Choices = Pick<RenderForm['fields'][number], 'presets' | 'customAmount' | 'intervals'>;

export function amountChoices(f: FormField, locale: string): Choices {
  if (f.type !== 'amount') return {};
  return {
    ...(f.presets
      ? {
          presets: f.presets.map((p) => ({ value: String(p), label: formatEuros(p, locale) })),
          ...(f.custom !== false
            ? {
                customAmount: {
                  choice: CUSTOM_AMOUNT_CHOICE,
                  name: customAmountName(f.name),
                  option: translate(locale, 'forms.amount.customChoice'),
                  label: translate(locale, 'forms.amount.other'),
                },
              }
            : {}),
        }
      : {}),
    // Once only needs no question; anything else is asked, the first offered checked.
    ...(f.intervals && f.intervals.join() !== 'once'
      ? {
          intervals: {
            legend: translate(locale, 'forms.amount.interval'),
            options: f.intervals.map((value) => ({
              value,
              label: translate(locale, `forms.amount.interval.${value}`),
            })),
          },
        }
      : {}),
  };
}

/** A membership form's choice of price, or nothing for another form (`form.get`'s `membership`). */
export function membershipChoices(
  membership: { name: Record<string, string>; prices: TierPrices } | null | undefined,
  locale: string,
  fallback: string
): Pick<RenderForm, 'membership'> {
  if (membership === undefined) return {};
  if (membership === null) return { membership: null };
  const name = pick(membership.name, locale, fallback) ?? '';
  return {
    membership: {
      legend: translate(locale, 'forms.membership.legend', { tier: name }),
      options: tierIntervals(membership.prices).map((interval) => ({
        value: interval,
        label: translate(locale, `forms.membership.price.${interval}`, {
          amount: formatEuros(membership.prices[interval]! / 100, locale),
        }),
      })),
    },
  };
}
