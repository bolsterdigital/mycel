import { describe, expect, it } from 'vitest';
import { issueLabel } from './issue-label.js';

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
    expect(issueLabel('featured.description.en', locales)).toEqual({
      key: 'admin.content.field.featuredDescription',
      locale: 'en',
      block: null,
    });
    expect(issueLabel('somethingElse', locales)).toBeNull();
  });
});
