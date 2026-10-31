// The keys stored rows already carry: a change here orphans admission seats, the
// erasure register a restore re-applies and the correlation of mail intents, so each formula is
// pinned to the bytes it had before it moved into email-key.ts.

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../util/digest.js';
import { EmailAddress, normalizeEmail } from '../util/email.js';
import { emailKey } from './email-key.js';

const T = '01900000-0000-7000-8000-00000000aaaa';

describe('emailKey', () => {
  it('keeps the formula every stored key was written with', async () => {
    const a = 'ada@example.org';
    expect(await emailKey(T, ' Ada@Example.org ', 'admission')).toBe(await sha256Hex(`${T}:${a}`));
    expect(await emailKey(T, a, 'rate-limit')).toBe(await sha256Hex(`${T}:${a}`));
    expect(await emailKey(T, 'ADA@example.org', 'erasure')).toBe(await sha256Hex(`${T}\n${a}`));
    expect(await emailKey(T, 'Ada@example.org', 'mail-correlation', 'Bevestig')).toBe(
      await sha256Hex(`${T}\n${a}\nBevestig`)
    );
  });

  it('normalises before it hashes, so every spelling of one address gives one key', async () => {
    const keys = await Promise.all(
      ['ada@example.org', ' ADA@example.org', 'Ada@Example.Org\n'].map((e) =>
        emailKey(T, e, 'erasure')
      )
    );
    expect(new Set(keys).size).toBe(1);
    expect(
      await emailKey('01900000-0000-7000-8000-00000000bbbb', 'ada@example.org', 'erasure')
    ).not.toBe(keys[0]);
  });

  it('agrees with the input schema', () => {
    for (const raw of [' Ada@Example.org', 'BOB@EXAMPLE.ORG  ', 'c@example.org'])
      expect(EmailAddress.parse(raw)).toBe(normalizeEmail(raw));
  });
});
