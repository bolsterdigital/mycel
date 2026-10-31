import { describe, expect, it } from 'vitest';
import { lastActivity, standOf } from './connection-stand.js';

const active = { state: 'active', credentialStatus: 'connected' };
const at = (minute: number) => `2026-10-31T12:${String(minute).padStart(2, '0')}:00.000Z`;

describe('connection stand', () => {
  it('is connected when the newest settled delivery arrived', () => {
    const intents = [
      { state: 'failed', updatedAt: at(1) },
      { state: 'succeeded', updatedAt: at(2) },
      { state: 'pending', updatedAt: at(3) },
    ];
    expect(standOf(active, intents)).toBe('connected');
    expect(standOf(active, [])).toBe('connected');
  });

  it('asks attention for an unknown outcome, a newest failure or a missing secret', () => {
    expect(standOf(active, [{ state: 'unknown', updatedAt: at(1) }])).toBe('attention');
    expect(
      standOf(active, [
        { state: 'succeeded', updatedAt: at(1) },
        { state: 'blocked', updatedAt: at(2) },
      ])
    ).toBe('attention');
    expect(standOf({ state: 'active', credentialStatus: 'reconnect-required' }, [])).toBe(
      'attention'
    );
  });

  it('keeps a paused connection paused unless an outcome is unknown, and a disconnected one off', () => {
    const paused = { state: 'paused', credentialStatus: 'reconnect-required' };
    expect(standOf(paused, [{ state: 'failed', updatedAt: at(1) }])).toBe('paused');
    expect(standOf(paused, [{ state: 'unknown', updatedAt: at(1) }])).toBe('attention');
    expect(
      standOf({ state: 'disconnected', credentialStatus: 'connected' }, [
        { state: 'unknown', updatedAt: at(1) },
      ])
    ).toBe('off');
  });

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
