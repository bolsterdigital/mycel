// #11 E: one registry and validator across public reads, agent writes and native admin posts.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { DEFAULT_THEME } from './presets.js';
import { DEFAULT_CHROME } from './settings.js';

const a = '01900000-0000-7000-8000-00000000aa11';
const b = '01900000-0000-7000-8000-00000000bb11';
const chrome = {
  ...DEFAULT_CHROME,
  navigation: [{ href: '/en/about', label: { nl: 'Over', en: 'About' } }],
  footer: { nl: 'Voet', en: 'Footer' },
};

describe('site settings', () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  it('isolates sites and checks versions separately', async () => {
    expect(
      await invoker.run(useCases.getSiteTheme, anonymousPrincipal(a, ['content:read']), {})
    ).toMatchObject({ version: 0, value: DEFAULT_THEME });
    expect(
      await invoker.run(useCases.updateSiteChrome, systemPrincipal(a, 'test'), {
        baseVersion: 0,
        chrome,
      })
    ).toMatchObject({ version: 1 });
    expect(
      await invoker.run(useCases.getSiteChrome, anonymousPrincipal(b, ['content:read']), {})
    ).toMatchObject({ version: 0, value: DEFAULT_CHROME });
    expect(
      await invoker.run(useCases.updateSiteTheme, systemPrincipal(a, 'test'), {
        baseVersion: 0,
        theme: { ...DEFAULT_THEME, baseSize: 20 },
      })
    ).toMatchObject({ version: 1 });
    expect(
      await invoker.run(useCases.getSiteChrome, anonymousPrincipal(a, ['content:read']), {})
    ).toMatchObject({ version: 1, value: chrome });
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(a, 'test'), { baseVersion: 0, chrome })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        chrome: { ...chrome, footer: { nl: '', en: '' } },
      })
    ).resolves.toMatchObject({ version: 1 });
  });
  it('rejects unsafe links and contrast failures at the use-case boundary', async () => {
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        chrome: { ...chrome, navigation: [{ href: 'javascript:alert(1)', label: { en: 'Bad' } }] },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.updateSiteTheme, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        theme: {
          ...DEFAULT_THEME,
          palettes: {
            ...DEFAULT_THEME.palettes,
            light: {
              ...DEFAULT_THEME.palettes.light,
              primary: { foreground: '#ffffff', background: '#ffffff' },
            },
          },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.updateSiteTheme, anonymousPrincipal(b, ['content:read']), {
        baseVersion: 0,
        theme: DEFAULT_THEME,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
