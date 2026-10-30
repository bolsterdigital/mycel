// The content locale (#66 PR 4): an item's `?locale=` wins for that view, then the stored choice
// while the site still has it, then the site's default; a translation is missing, behind or ok
// by core's readiness; the shell's return path stays inside this site's admin.

import { describe, expect, it } from 'vitest';
import { ContentDocument } from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';
import { contentLocale, returnPath, translationState } from './content-locale.js';

const jar = (value?: string) => ({ get: () => value }) as unknown as Cookies;
const site = { locales: ['nl', 'en'], defaultLocale: 'nl' };

describe('contentLocale', () => {
  it('takes the asked locale, then the stored choice, then the default', () => {
    expect(contentLocale(jar('en'), site, 'nl')).toBe('nl');
    expect(contentLocale(jar('en'), site, null)).toBe('en');
    expect(contentLocale(jar(), site, null)).toBe('nl');
  });

  it('ignores a locale the site does not have, asked or stored', () => {
    expect(contentLocale(jar('de'), site, 'fr')).toBe('nl');
    expect(contentLocale(jar(), site, 'de', ['nl', 'en', 'de'])).toBe('de');
  });
});

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

describe('returnPath', () => {
  it('keeps a path of this site without its locale', () => {
    expect(returnPath('/admin/probe/content?type=page&locale=en', 'probe')).toBe(
      '/admin/probe/content?type=page'
    );
    expect(returnPath('/admin/probe', 'probe')).toBe('/admin/probe');
  });

  it('refuses another site, another origin and a look-alike prefix', () => {
    expect(returnPath('/admin/other/content', 'probe')).toBeNull();
    expect(returnPath('//evil.example/admin/probe', 'probe')).toBeNull();
    expect(returnPath('https://evil.example/admin/probe', 'probe')).toBeNull();
    expect(returnPath('/admin/probe-two', 'probe')).toBeNull();
    expect(returnPath('/admin/probe/../other', 'probe')).toBeNull();
  });
});
