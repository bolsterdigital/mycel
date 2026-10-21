import { describe, expect, it } from 'vitest';
import { SupporterEvent } from './events.js';

describe('SupporterEvent envelope', () => {
  const base = {
    schema: 'wings.supporter-event.v1',
    id: 'abc',
    type: 'petition.signed',
    email: '  Jan@Example.ORG ',
    occurred_at: '2026-06-12T17:04:11+00:00',
    source: 'backfill',
    source_site: 'https://www.frissewind.nu',
    source_ref: 'gf-entry:1234',
  };

  it('normalises the e-mail address, the identity key', () => {
    const parsed = SupporterEvent.parse(base);
    expect(parsed.email).toBe('jan@example.org');
    expect(parsed.props).toEqual({});
  });

  it('rejects unknown event types instead of storing them', () => {
    expect(() => SupporterEvent.parse({ ...base, type: 'something.new' })).toThrow();
  });
});
