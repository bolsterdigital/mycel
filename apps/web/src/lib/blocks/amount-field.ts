// What a form block shows of a gift's amount field (MY-252 PR 2, MY-254 PR 2): the presets as
// "€ 25", the label of an amount of one's own, and the question how often, each in the page's
// locale. Apart from resolve.ts, which is at its size ceiling; the field is the same data there.

import { translate, type FormField } from '@mycel/core';
import { formatEuros } from '../money.js';
import type { RenderForm } from './model.js';

type Choices = Pick<RenderForm['fields'][number], 'presets' | 'otherLabel' | 'intervals'>;

export function amountChoices(f: FormField, locale: string): Choices {
  if (f.type !== 'amount') return {};
  return {
    ...(f.presets
      ? {
          presets: f.presets.map((p) => ({ value: String(p), label: formatEuros(p, locale) })),
          ...(f.custom !== false ? { otherLabel: translate(locale, 'forms.amount.other') } : {}),
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
