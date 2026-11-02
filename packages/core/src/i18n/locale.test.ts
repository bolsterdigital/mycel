import { describe, expect, it } from 'vitest';
import { pickAny } from './locale.js';

describe('pickAny', () => {
  it('takes the first locale that has a value, in the order asked', () => {
    expect(pickAny({ nl: 'Hallo', en: 'Hello' }, 'en', 'nl')).toBe('Hello');
    expect(pickAny({ nl: 'Hallo' }, 'en', 'nl')).toBe('Hallo');
  });

  it('falls back to any locale that has a value', () => {
    expect(pickAny({ de: 'Hallo' }, 'en', 'nl')).toBe('Hallo');
    expect(pickAny({ de: undefined, fr: 'Salut' }, 'en')).toBe('Salut');
  });

  it('keeps an empty string the locale really has', () => {
    expect(pickAny({ en: '', nl: 'Hallo' }, 'en')).toBe('');
  });

  it('has nothing to give for an empty map', () => {
    expect(pickAny({}, 'en')).toBeUndefined();
  });
});
