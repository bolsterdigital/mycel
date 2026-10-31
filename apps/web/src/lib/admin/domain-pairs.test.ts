import { describe, expect, it } from 'vitest';
import { domainEntries, mainDomainNames } from './domain-pairs.js';

const custom = (hostname: string) => ({ hostname, kind: 'custom' as const });
const platform = (hostname: string) => ({ hostname, kind: 'platform' as const });

describe('mainDomainNames', () => {
  it('gives the bare name and the www name, whichever was typed', () => {
    expect(mainDomainNames('example.org')).toEqual({
      apex: 'example.org',
      www: 'www.example.org',
    });
    expect(mainDomainNames('www.example.org')).toEqual({
      apex: 'example.org',
      www: 'www.example.org',
    });
  });
});

describe('domainEntries', () => {
  it('pairs a bare name with its www name in list order, wherever each stands', () => {
    const list = [
      platform('probe.mycel.test'),
      custom('www.example.org'),
      custom('campaign.other.org'),
      custom('example.org'),
    ];
    expect(domainEntries(list)).toEqual([
      { kind: 'single', hostname: list[0] },
      { kind: 'pair', apex: list[3], www: list[1] },
      { kind: 'single', hostname: list[2] },
    ]);
  });

  it('leaves a lone name single, and never pairs a platform hostname', () => {
    const list = [
      platform('example.org'),
      custom('www.example.org'),
      custom('www.alone.org'),
      custom('bare.org'),
    ];
    expect(domainEntries(list).map((e) => e.kind)).toEqual([
      'single',
      'single',
      'single',
      'single',
    ]);
  });
});
