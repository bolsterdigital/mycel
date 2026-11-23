export function documentOf(href: string): string | null;
export function cardFor(target: string, hrefs: string[]): number;
export function isThanks(page: string, thanks: string): boolean;
export function side(input: {
  moment: 'swap' | 'reveal';
  here: string;
  other: string;
  card: boolean;
  pair: { list: string; item: string } | null;
}): 'card' | 'item' | null;
