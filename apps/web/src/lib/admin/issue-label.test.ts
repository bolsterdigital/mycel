import { describe, expect, it } from 'vitest';
import { fieldAnchor, issueLabel } from './issue-label.js';

describe('issueLabel', () => {
  it('names an issue by the label of its field, its locale and its block', () => {
    const locales = ['nl', 'en'];
    expect(issueLabel('title.en', locales)).toEqual({
      key: 'admin.content.field.title',
      locale: 'en',
      block: null,
    });
    expect(issueLabel('seo.description.nl', locales)?.key).toBe(
      'admin.content.field.seoDescription'
    );
    expect(issueLabel('blocks.2.props.text.en', locales)).toEqual({
      key: 'admin.block.field.text',
      locale: 'en',
      block: 3,
    });
    expect(issueLabel('featuredImageId', locales)?.key).toBe('admin.content.field.featuredImage');
    expect(issueLabel('seo.imageId', locales)?.key).toBe('admin.content.field.shareImage');
    expect(issueLabel('heroImageId', locales)?.key).toBe('admin.content.field.heroImage');
    expect(issueLabel('heroAlt.en', locales)).toMatchObject({
      key: 'admin.content.field.heroAlt',
      locale: 'en',
    });
    expect(issueLabel('featured.description.en', locales)).toEqual({
      key: 'admin.content.field.featuredDescription',
      locale: 'en',
      block: null,
    });
    expect(issueLabel('somethingElse', locales)).toBeNull();
  });
});

describe('fieldAnchor', () => {
  it('links the writer to its own surface, not to a mangled block id', () => {
    expect(fieldAnchor('articleEditor', 'nl')).toBe('articleEditor');
  });
  it('keeps the rule for document fields, locales and block fields', () => {
    expect(fieldAnchor('teaser', 'nl')).toBe('teaser');
    expect(fieldAnchor('locales', 'nl')).toBe('locale-nl');
    expect(fieldAnchor('b.abc.p.text.nl', 'nl')).toBe('b-abc-p-text-nl');
    expect(fieldAnchor('new.p.text.nl', 'nl')).toBe('b-new-p-text-nl');
  });
});
