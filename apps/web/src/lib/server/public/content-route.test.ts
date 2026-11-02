import { describe, expect, it } from 'vitest';
import { localeOf, parseContentPath, thanksPath } from './content-route.js';

describe('parseContentPath', () => {
  it('reads pages, the homepage, articles and thank-you pages', () => {
    expect(parseContentPath('')).toEqual({ type: 'page', slug: 'index', thanks: false });
    expect(parseContentPath('thanks')).toEqual({ type: 'page', slug: 'index', thanks: true });
    expect(parseContentPath('about')).toEqual({ type: 'page', slug: 'about', thanks: false });
    expect(parseContentPath('signup/thanks')).toEqual({
      type: 'page',
      slug: 'signup',
      thanks: true,
    });
    expect(parseContentPath('articles/story')).toEqual({
      type: 'article',
      slug: 'story',
      thanks: false,
    });
    expect(parseContentPath('articles/story/thanks')).toEqual({
      type: 'article',
      slug: 'story',
      thanks: true,
    });
  });

  it('is a 404 for everything else', () => {
    for (const path of [
      'index',
      'articles',
      'articles/',
      'authors/sam',
      'a/b',
      'About',
      'articles/Story',
      'about/thanks/thanks',
      'articles/story/more',
      '-x',
    ])
      expect(parseContentPath(path), path).toBeNull();
  });
});

describe('localeOf', () => {
  const site = { defaultLocale: 'nl', locales: ['nl', 'en'] };
  it('is the default without a prefix and another site locale with one', () => {
    expect(localeOf(undefined, site)).toBe('nl');
    expect(localeOf('en', site)).toBe('en');
  });
  it('refuses the default as a prefix and a locale the site lacks', () => {
    expect(localeOf('nl', site)).toBeNull();
    expect(localeOf('de', site)).toBeNull();
  });
});

describe('thanksPath', () => {
  it('follows the item path, and the homepage has /thanks', () => {
    expect(thanksPath({ type: 'page', slug: 'signup' }, 'nl', 'nl')).toBe('/signup/thanks');
    expect(thanksPath({ type: 'page', slug: 'signup' }, 'en', 'nl')).toBe('/en/signup/thanks');
    expect(thanksPath({ type: 'page', slug: 'index' }, 'nl', 'nl')).toBe('/thanks');
    expect(thanksPath({ type: 'page', slug: 'index' }, 'en', 'nl')).toBe('/en/thanks');
    expect(thanksPath({ type: 'article', slug: 'x' }, 'nl', 'nl')).toBe('/articles/x/thanks');
  });
});
