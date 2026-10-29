import { describe, expect, it } from 'vitest';
import { ifNoneMatch } from './conditional.js';

const ETAG = '"r1:abc"';

describe('ifNoneMatch', () => {
  it('compares weakly, reads a list and knows *', () => {
    expect(ifNoneMatch(null, ETAG)).toBe(false);
    expect(ifNoneMatch(undefined, ETAG)).toBe(false);
    expect(ifNoneMatch('*', ETAG)).toBe(true);
    expect(ifNoneMatch(`W/${ETAG}`, ETAG)).toBe(true);
    expect(ifNoneMatch(`"other", ${ETAG}`, ETAG)).toBe(true);
    expect(ifNoneMatch('"other"', ETAG)).toBe(false);
  });
});
