import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS, issueSession, readSession } from './session.js';
import { FakeClock, FakeSigner } from '../testing/index.js';

const OPERATOR = { id: '01900000-0000-7000-8000-000000000001', email: 'a@example.org', name: 'A' };

describe('operator session codec', () => {
  it('round-trips and issues a new value on every login', async () => {
    const clock = new FakeClock();
    const signer = new FakeSigner();
    const first = await issueSession(signer, clock, OPERATOR);
    const second = await issueSession(signer, clock, OPERATOR);
    expect(first.token).not.toBe(second.token);
    expect(await readSession(signer, clock, first.token)).toEqual({
      operatorId: OPERATOR.id,
      email: OPERATOR.email,
      name: 'A',
      issuedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + SESSION_TTL_MS),
    });
  });

  it('expires after twelve hours, without renewal', async () => {
    const clock = new FakeClock();
    const signer = new FakeSigner();
    const { token } = await issueSession(signer, clock, OPERATOR);
    clock.advance(SESSION_TTL_MS - 1);
    expect(await readSession(signer, clock, token)).not.toBeNull();
    clock.advance(1);
    expect(await readSession(signer, clock, token)).toBeNull();
  });

  it('rejects tampering, other token kinds and garbage', async () => {
    const clock = new FakeClock();
    const signer = new FakeSigner();
    const { token } = await issueSession(signer, clock, OPERATOR);
    expect(
      await readSession(signer, clock, token.replace('a@example.org', 'b@example.org'))
    ).toBeNull();
    // A validly signed payload of another kind (a form timing token) is not a session.
    const other = await signer.sign(JSON.stringify({ f: 'form', t: clock.now().getTime() }));
    expect(await readSession(signer, clock, other)).toBeNull();
    const longer = await signer.sign(
      JSON.stringify({
        v: 1,
        typ: 'session',
        sid: 'x'.repeat(32),
        op: OPERATOR.id,
        email: OPERATOR.email,
        name: null,
        iat: clock.now().getTime(),
        exp: clock.now().getTime() + 2 * SESSION_TTL_MS,
      })
    );
    expect(await readSession(signer, clock, longer)).toBeNull();
    for (const junk of [undefined, '', 'nope', await signer.sign('not json')])
      expect(await readSession(signer, clock, junk)).toBeNull();
  });
});
