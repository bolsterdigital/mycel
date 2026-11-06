import { describe, expect, it } from 'vitest';
import { attentionSince, standOf } from './stand.js';

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

  it('dates attention from its newest reason, and only while it asks', () => {
    const d = (minute: number) => new Date(at(minute));
    const c = { ...active, updatedAt: d(0) };
    expect(attentionSince(c, [{ state: 'succeeded', updatedAt: d(1) }])).toBeNull();
    expect(
      attentionSince(c, [
        { state: 'unknown', updatedAt: d(2) },
        { state: 'failed', updatedAt: d(5) },
      ])
    ).toEqual(d(5));
    expect(attentionSince({ ...c, credentialStatus: 'reconnect-required' }, [])).toEqual(d(0));
    // A paused connection asks only for an unknown outcome, so a later failure does not date it.
    expect(
      attentionSince({ ...c, state: 'paused' }, [
        { state: 'unknown', updatedAt: d(2) },
        { state: 'failed', updatedAt: d(5) },
      ])
    ).toEqual(d(2));
  });
});
