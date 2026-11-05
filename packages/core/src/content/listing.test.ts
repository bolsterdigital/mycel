// Where a translation stands, which a list reports and filters on. Which items a list matches and
// in what order runs over both adapters in `packages/db/src/adapter-rules.test.ts`.

import { describe, expect, it } from 'vitest';
import { translationState } from './listing.js';
import { ContentDocument } from './model.js';

describe('translationState', () => {
  const doc = ContentDocument.parse({
    type: 'page',
    title: { nl: 'Titel', en: 'Title' },
    lead: { nl: 'Kern' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    blocks: [],
  });
  it('names a locale missing, behind or ok', () => {
    expect(translationState(doc, 'nl')).toBe('ok');
    expect(translationState(doc, 'en')).toBe('behind');
    expect(translationState(doc, 'de')).toBe('missing');
  });
});
