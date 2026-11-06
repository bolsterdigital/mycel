import { describe, expect, it } from 'vitest';
import { lastActivity } from './connection-stand.js';

// The stand rule itself is tested in core (packages/core/src/connections/stand.test.ts).
const at = (minute: number) => `2026-10-31T12:${String(minute).padStart(2, '0')}:00.000Z`;

describe('connection last activity', () => {
  it('names the newest attempt as the last activity', () => {
    expect(lastActivity([])).toBeNull();
    expect(
      lastActivity([
        { state: 'succeeded', updatedAt: at(4) },
        { state: 'pending', updatedAt: at(9) },
      ])
    ).toBe(at(9));
  });
});
