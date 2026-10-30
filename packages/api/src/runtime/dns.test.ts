import { describe, expect, it } from 'vitest';
import { DnsUnavailableError } from '@mycel/core';
import { createDnsResolver } from './dns.js';

/** A resolver whose every lookup fails with `code`. */
const failing = (code: string) => {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error(code), { code });
  };
  return createDnsResolver({
    resolver: { resolveTxt: fail, resolveCname: fail, resolve4: fail, resolve6: fail },
  });
};

describe('DNS adapter', () => {
  it('joins TXT chunks and normalises a CNAME', async () => {
    const dns = createDnsResolver({
      resolver: {
        resolveTxt: async () => [['abc', 'def'], ['x']],
        resolveCname: async () => ['Probe.Mycel.Site.'],
        resolve4: async () => [],
        resolve6: async () => [],
      },
    });
    expect(await dns.txt('_mycel-verify.example.org')).toEqual(['abcdef', 'x']);
    expect(await dns.cname('example.org')).toBe('probe.mycel.site');
  });

  it('joins A and AAAA answers, either family may be missing', async () => {
    const missing = async (): Promise<never> => {
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    };
    const dns = (resolve6: () => Promise<string[]>) =>
      createDnsResolver({
        resolver: {
          resolveTxt: missing,
          resolveCname: missing,
          resolve4: async () => ['8.8.8.8'],
          resolve6,
        },
      });
    expect(await dns(async () => ['2606:4700:4700::1111']).addresses('x')).toEqual([
      '8.8.8.8',
      '2606:4700:4700::1111',
    ]);
    expect(await dns(missing).addresses('x')).toEqual(['8.8.8.8']);
  });

  it('answers "not found" for a missing name or record', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      expect(await failing(code).txt('x')).toEqual([]);
      expect(await failing(code).cname('x')).toBeNull();
      expect(await failing(code).addresses('x')).toEqual([]);
    }
  });

  it('reports no answer, never "not found", for a server failure or a time-out', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']) {
      await expect(failing(code).txt('x')).rejects.toBeInstanceOf(DnsUnavailableError);
      await expect(failing(code).cname('x')).rejects.toBeInstanceOf(DnsUnavailableError);
      await expect(failing(code).addresses('x')).rejects.toBeInstanceOf(DnsUnavailableError);
    }
  });

  it('lets anything else through', async () => {
    await expect(failing('EBADNAME').txt('x')).rejects.toThrow('EBADNAME');
  });
});
