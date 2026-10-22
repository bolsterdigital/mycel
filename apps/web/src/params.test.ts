import { describe, expect, it } from 'vitest';
import { Locale, isReservedPageSlug } from '@mycel/core';
import { params } from './params.js';

const match = (s: string) => {
  const result = params.locale['~standard'].validate(s);
  return !('issues' in result && result.issues);
};

describe('locale param matcher', () => {
  it("is core's Locale pattern", () => {
    for (const s of ['nl', 'en', 'fry', 'de-AT', 'pt-BR', 'NL', 'en-gb', 'about', 'e', '', 'x-'])
      expect(match(s), s).toBe(Locale.safeParse(s).success);
  });

  it('never matches a slug a page can have', () => {
    for (const slug of ['signup', 'about', 'articles', 'thanks', 'draft-check', 'faq', 'a1'])
      if (match(slug)) expect(isReservedPageSlug(slug), slug).toBe(true);
  });
});
