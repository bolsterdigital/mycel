// The operator's own preferences (#88): kept per operator, read back with the defaults,
// refused when a value is not one core knows. The operator id is the session's, so a form cannot
// name another operator; an input that tries is refused rather than ignored.
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  DEFAULT_OPERATOR_PREFERENCES,
  operatorPreferences,
  updateOperatorPreferences,
} from './preferences.js';
import { MemoryIdentityStore, MemoryStore, MemoryTenants } from '../testing/memory.js';

async function setup() {
  const store = new MemoryStore();
  const identity = new MemoryIdentityStore(store, new MemoryTenants());
  const login = (subject: string) =>
    identity.login({
      issuer: 'https://idp.test',
      subject,
      email: `${subject}@example.org`,
      emailVerified: true,
    });
  return { identity, own: await login('own'), other: await login('other') };
}

describe('operator preferences', () => {
  it('reads the defaults until the operator saves, and keeps them per operator', async () => {
    const { identity, own, other } = await setup();
    expect(await operatorPreferences(identity, own.id)).toEqual(DEFAULT_OPERATOR_PREFERENCES);
    const chosen = { uiLocale: 'nl', timeZone: 'Asia/Tokyo', dateFormat: 'absolute' } as const;
    expect(await updateOperatorPreferences(identity, own.id, chosen)).toEqual(chosen);
    expect(await operatorPreferences(identity, own.id)).toEqual(chosen);
    expect(await operatorPreferences(identity, other.id)).toEqual(DEFAULT_OPERATOR_PREFERENCES);
  });

  it('refuses an input that names another operator, and leaves theirs alone', async () => {
    const { identity, own, other } = await setup();
    await expect(
      updateOperatorPreferences(identity, own.id, {
        ...DEFAULT_OPERATOR_PREFERENCES,
        uiLocale: 'en',
        operatorId: other.id,
      })
    ).rejects.toBeInstanceOf(ZodError);
    expect(await operatorPreferences(identity, other.id)).toEqual(DEFAULT_OPERATOR_PREFERENCES);
    expect(await operatorPreferences(identity, own.id)).toEqual(DEFAULT_OPERATOR_PREFERENCES);
  });

  it('refuses a language, zone or date display core does not know', async () => {
    const { identity, own } = await setup();
    for (const bad of [
      { uiLocale: 'de' },
      { timeZone: 'Mars/Olympus' },
      { timeZone: '+01:00' },
      { dateFormat: 'sometimes' },
    ])
      await expect(
        updateOperatorPreferences(identity, own.id, { ...DEFAULT_OPERATOR_PREFERENCES, ...bad })
      ).rejects.toBeInstanceOf(ZodError);
    expect(await operatorPreferences(identity, own.id)).toEqual(DEFAULT_OPERATOR_PREFERENCES);
  });
});
