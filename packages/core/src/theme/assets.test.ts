// Registry proof for #11 F: the same capability and version guard fronts share, with independent
// logo/font state and no change to theme or chrome.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { DEFAULT_CHROME } from './settings.js';
import { EXAMPLE_PNG } from '../media/service.js';

const a = '01900000-0000-7000-8000-00000000aa31';
const b = '01900000-0000-7000-8000-00000000bb31';
const png = EXAMPLE_PNG;

describe('brand asset registry', () => {
  it('keeps independent versions, tenants and other settings', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(a, 'test');
    await expect(
      invoker.run(useCases.putBrandAsset, anonymousPrincipal(a, ['content:read']), {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes: png,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await invoker.run(useCases.putBrandAsset, principal, {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes: png,
      })
    ).toMatchObject({ version: 1, active: true, width: 1 });
    expect(
      await invoker.run(useCases.getBrandAsset, anonymousPrincipal(b, ['content:read']), {
        kind: 'logo',
      })
    ).toMatchObject({ version: 0, active: false });
    await expect(
      invoker.run(useCases.putBrandAsset, principal, {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes: png,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await invoker.run(useCases.getBrandAsset, principal, { kind: 'font' })).toMatchObject({
      version: 0,
      active: false,
    });
    await expect(
      invoker.run(useCases.putBrandAsset, principal, {
        kind: 'font',
        baseVersion: 0,
        contentType: 'font/woff2',
        bytes: png,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await invoker.run(useCases.getSiteChrome, principal, {})).value).toEqual(
      DEFAULT_CHROME
    );
    expect(
      await invoker.run(useCases.removeBrandAsset, principal, { kind: 'logo', baseVersion: 1 })
    ).toMatchObject({ version: 2, active: false });
  });
});
