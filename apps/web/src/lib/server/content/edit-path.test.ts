import { describe, expect, it } from 'vitest';
import { mergedWithOf } from './edit-path.js';

// ADR 026 rule 4 as the edit screen reads it: which save merged, so `held` and the notices
// fire. The e2e "publishing changes another save already made" runs the no-op case end to end.
describe('mergedWithOf', () => {
  const base = '00000000-0000-4000-8000-000000000001';
  const newest = '00000000-0000-4000-8000-000000000002';
  const written = '00000000-0000-4000-8000-000000000003';

  it('names the newest a written merge records', () => {
    const merged = { merged: { baseRevisionId: base, latestRevisionId: newest } };
    expect(mergedWithOf({ id: written, provenance: merged }, { id: newest })).toBe(newest);
  });

  it('counts a save on an older base that returned the newest, which core did not write', () => {
    expect(mergedWithOf({ id: newest, provenance: null }, { id: newest })).toBe(newest);
  });

  it('is null for a save on the newest base, and for a revision of its own', () => {
    expect(mergedWithOf({ id: written, provenance: null }, null)).toBeNull();
    expect(mergedWithOf({ id: written, provenance: null }, { id: newest })).toBeNull();
  });
});
