import { describe, expect, it } from 'vitest';
import { bearerMatches } from './bearer.js';

describe('bearerMatches', () => {
  it('matches only the exact token after Bearer', () => {
    expect(bearerMatches('Bearer s3cret-token', 's3cret-token')).toBe(true);
    expect(bearerMatches('bearer   s3cret-token  ', 's3cret-token')).toBe(true);
    expect(bearerMatches('Bearer s3cret-tokeN', 's3cret-token')).toBe(false);
    expect(bearerMatches('Bearer s3cret', 's3cret-token')).toBe(false);
    expect(bearerMatches('Basic s3cret-token', 's3cret-token')).toBe(false);
    expect(bearerMatches('Bearer a b', 'a b')).toBe(false);
    expect(bearerMatches(undefined, 's3cret-token')).toBe(false);
  });

  it('refuses everyone when no token is configured', () => {
    expect(bearerMatches('Bearer anything', undefined)).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});
