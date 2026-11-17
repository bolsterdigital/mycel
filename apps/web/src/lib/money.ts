// How an amount reads on a page (ADR 005 rule 1: integers in minor units with their currency):
// "€ 25" and "€ 12,50" in Dutch, "€25" and "€12.50" in English. Whole amounts without decimals,
// since a gift is mostly a round number. Client-safe; the donation form, the return page, the
// fake payment screen and the admin list all format through here.

/** An amount in minor units (cents). */
export function formatMoney(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);
}

/** An amount in euros, as a form's amount field holds it. */
export const formatEuros = (euros: number, locale: string): string =>
  formatMoney(Math.round(euros * 100), 'EUR', locale);
