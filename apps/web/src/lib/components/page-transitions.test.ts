// The floating pairs' choice (MY-269 PR 2, brief view-transitions § PR 2): which card on a page
// leads to the other page, and which side of a pair a page is in one navigation. The DOM adapter
// (names on the parts, `pageswap` and `pagereveal`) is proven in the browser
// (e2e/lib/navigation/pairs.ts).
import { describe, expect, it } from 'vitest';
import { cardFor, documentOf, isThanks, side } from '../../../static/_site/transitions.js';

const LIST = 'https://site.test/nieuws';
const ITEM = 'https://site.test/articles/faunapassages';

describe('the card that leads to a page', () => {
  it('finds the card whose link leads to the target', () => {
    expect(cardFor(ITEM, ['https://site.test/articles/other', ITEM])).toBe(1);
  });

  it('takes the first card when several link to the same page', () => {
    expect(cardFor(ITEM, [ITEM, 'https://site.test/x', `${ITEM}#top`])).toBe(0);
    expect(cardFor(ITEM, ['https://site.test/x', `${ITEM}#top`, ITEM])).toBe(1);
  });

  it('finds nothing without a match, and never matches a different query', () => {
    expect(cardFor(ITEM, ['https://site.test/x', `${ITEM}?page=2`])).toBe(-1);
    expect(cardFor(ITEM, [])).toBe(-1);
    expect(cardFor('not a url', [ITEM])).toBe(-1);
  });

  it('compares documents: the fragment does not change the page', () => {
    expect(documentOf(`${ITEM}#reacties`)).toBe(ITEM);
    expect(documentOf('nonsense')).toBeNull();
  });
});

describe('the thank-you view of a landing page', () => {
  it('is the landing path plus /thanks on the same origin', () => {
    expect(isThanks(ITEM, `${ITEM}/thanks`)).toBe(true);
    expect(isThanks('https://site.test/', 'https://site.test/thanks')).toBe(true);
    expect(isThanks(ITEM, 'https://other.test/articles/faunapassages/thanks')).toBe(false);
    expect(isThanks(ITEM, `${LIST}/thanks`)).toBe(false);
  });
});

describe('the side of a pair', () => {
  const pair = { list: LIST, item: ITEM };

  it('a list page names its card on the way out, the item page its header on arrival', () => {
    expect(side({ moment: 'swap', here: LIST, other: ITEM, card: true, pair: null })).toBe('card');
    expect(side({ moment: 'reveal', here: ITEM, other: LIST, card: false, pair })).toBe('item');
  });

  it('back to the list: the header leaves, the card that led there arrives', () => {
    expect(side({ moment: 'swap', here: ITEM, other: LIST, card: false, pair })).toBe('item');
    expect(side({ moment: 'reveal', here: LIST, other: ITEM, card: true, pair })).toBe('card');
  });

  it('two pages that no card connects name nothing', () => {
    const other = 'https://site.test/over-ons';
    expect(side({ moment: 'swap', here: ITEM, other, card: false, pair })).toBeNull();
    expect(side({ moment: 'reveal', here: other, other: ITEM, card: false, pair })).toBeNull();
    expect(side({ moment: 'reveal', here: ITEM, other: LIST, card: false, pair: null })).toBeNull();
  });

  it('a list page without the card names nothing on arrival, even for the recorded pair', () => {
    expect(side({ moment: 'reveal', here: LIST, other: ITEM, card: false, pair })).toBeNull();
  });

  it('a landing page and its thank-you view are both headers', () => {
    const thanks = `${ITEM}/thanks`;
    expect(side({ moment: 'swap', here: ITEM, other: thanks, card: false, pair: null })).toBe(
      'landing'
    );
    expect(side({ moment: 'reveal', here: thanks, other: ITEM, card: false, pair: null })).toBe(
      'landing'
    );
  });
});
