import { describe, expect, it } from 'vitest';
import { noteRebase } from './edit-path.js';

// ADR 027: a block operation rebased onto a newer revision is a merge for the screen too; the
// e2e "a block action on an outdated screen is rebased and says so" runs it end to end.
describe('noteRebase', () => {
  const base = '00000000-0000-4000-8000-000000000001';
  const newest = '00000000-0000-4000-8000-000000000002';
  const written = '00000000-0000-4000-8000-000000000003';
  const saved = (mergedWith: string | null) => ({
    tenant: { slug: 'probe' },
    editing: null,
    mergedWith,
  });
  const rebased = {
    revision: {
      id: written,
      provenance: { merged: { baseRevisionId: base, latestRevisionId: newest } },
    },
  };

  it('names the revision a rebased operation merged with, and returns what it got', () => {
    const s = saved(null);
    expect(noteRebase(s, rebased)).toBe(rebased);
    expect(s.mergedWith).toBe(newest);
  });

  it('keeps the merge the save already found, and ignores a plain or absent result', () => {
    const s = saved(base);
    noteRebase(s, rebased);
    expect(s.mergedWith).toBe(base);
    const plain = saved(null);
    noteRebase(plain, { revision: { id: written, provenance: null } });
    noteRebase(plain, undefined);
    expect(plain.mergedWith).toBeNull();
  });
});
