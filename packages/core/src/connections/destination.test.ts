// The pure address rule replaced Node's BlockList; these cases pin that it still refuses every
// special-purpose range the transport refused before (TODO #49).
import { describe, expect, it } from 'vitest';
import { FakeDns } from '../testing/memory.js';
import { checkDestination, publicAddress } from './destination.js';

describe('webhook destination', () => {
  it.each([
    '0.1.2.3',
    '10.2.3.4',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001::1',
    '2001:db8::1',
    '2002:c000:204::1',
    '3fff::1',
    '256.1.1.1',
    'not-an-address',
    '1:2:3:4:5:6:7:8:9',
  ])('refuses %s', (address) => expect(publicAddress(address)).toBe(false));

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '3fff:1000::1',
  ])('accepts %s', (address) => expect(publicAddress(address)).toBe(true));

  it('refuses non-HTTPS, literal addresses, other ports and mixed answers', async () => {
    const dns = new FakeDns();
    dns.addressRecords.set('hooks.example.org', ['8.8.8.8']);
    dns.addressRecords.set('mixed.example.org', ['8.8.8.8', '169.254.169.254']);
    for (const url of [
      'http://hooks.example.org/',
      'https://127.0.0.1/',
      'https://0x7f.1/',
      'https://[::1]/',
      'https://hooks.example.org:8443/',
      'https://localhost/',
      'https://printer.local/',
      'https://hooks.example.org/?token=x',
      'https://mixed.example.org/',
    ])
      await expect(checkDestination(dns, url)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await checkDestination(dns, 'https://hooks.example.org/mycel')).toMatchObject({
      address: '8.8.8.8',
    });
  });
});
