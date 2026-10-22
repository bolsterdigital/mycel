import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import {
  dnsInstruction,
  normalizeCustomHostname,
  normalizeHostname,
  platformHostname,
  underDomain,
} from './model.js';

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UseCaseError);
    expect((e as UseCaseError).code).toBe('invalid_input');
    return;
  }
  throw new Error('expected invalid_input');
};

describe('normalizeHostname', () => {
  it.each([
    ['www.example.org', 'www.example.org'],
    ['  WWW.Example.ORG. ', 'www.example.org'],
    ['müller.de', 'xn--mller-kva.de'],
    ['ΜΟΥΣΕΊΟ.gr', 'xn--kxalumcvn.gr'],
    ['a.b', 'a.b'],
    ['probe.localhost', 'probe.localhost'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeHostname(raw)).toBe(expected);
  });

  it.each([
    '',
    'example.org:8080',
    'example.org/path',
    'user@example.org',
    'http://example.org',
    '203.0.113.7',
    '[2001:db8::1]',
    'exa mple.org',
    '-bad.example.org',
    'bad-.example.org',
    'under_score.example.org',
    `${'a'.repeat(64)}.example.org`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.org`,
  ])('rejects %j', (raw) => {
    invalid(() => normalizeHostname(raw));
  });
});

describe('normalizeCustomHostname', () => {
  const platform = { domain: 'mycel.site', devHosts: ['localhost', '127.0.0.1'] };

  it('accepts a domain the tenant brings', () => {
    expect(normalizeCustomHostname('Www.Example.org', platform)).toBe('www.example.org');
  });

  it.each(['mycel.site', 'probe.mycel.site', 'a.b.mycel.site', 'localhost', '127.0.0.1'])(
    'rejects %s',
    (raw) => {
      invalid(() => normalizeCustomHostname(raw, platform));
    }
  );

  it('does not confuse a domain that merely ends in the platform domain', () => {
    expect(normalizeCustomHostname('notmycel.site', platform)).toBe('notmycel.site');
    expect(underDomain('notmycel.site', 'mycel.site')).toBe(false);
  });
});

describe('dnsInstruction', () => {
  it('names the TXT record and the CNAME target', () => {
    expect(dnsInstruction('www.example.org', 'tok', 'probe', 'mycel.site')).toEqual({
      txt: { name: '_mycel-verify.www.example.org', value: 'tok' },
      cname: { name: 'www.example.org', target: 'probe.mycel.site' },
    });
    expect(platformHostname('probe', 'localhost')).toBe('probe.localhost');
  });
});
