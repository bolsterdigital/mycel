// Exercise the production form mapping with the real registry: core-only consent tests cannot
// detect the front silently substituting today's processor for the one the administrator saw.
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, principal } from '@mycel/core/testing';
import { saveAssistSettings } from './assist-settings.js';

const operator = principal({
  actor: {
    kind: 'operator',
    operatorId: '01900000-0000-7000-8000-00000000a001',
    email: 'consent@probe.test',
  },
});
function form(provider?: string) {
  const data = new FormData();
  data.set('enabled', 'on');
  data.set('consent', 'on');
  if (provider !== undefined) data.set('provider', provider);
  return data;
}
function setup() {
  const uow = new MemoryUnitOfWork({ assistProviderLabel: 'Processor A' });
  let invoker = new Invoker(buildRegistry(), uow);
  const settings = () => invoker.run(useCases.getAssistSettings, operator, {});
  // A deployment composes new ports over the same persisted tenant state.
  const deploy = (provider: string | null) => {
    const next = new MemoryUnitOfWork({ store: uow.store, assistProviderLabel: provider });
    invoker = new Invoker(buildRegistry(), next);
    return invoker;
  };
  return { invoker, settings, deploy };
}

describe('native assistance consent', () => {
  it('refuses A-render → B-configuration → old POST without changing consent; fresh B succeeds', async () => {
    const { invoker: initial, settings, deploy } = setup();
    let invoker = initial;
    const displayed = await settings();
    await saveAssistSettings(invoker, operator, form(displayed.provider!));
    invoker = deploy('Processor B');
    const before = await settings();
    expect(before.consentedProvider).toBe('Processor A');
    expect(await saveAssistSettings(invoker, operator, form(displayed.provider!))).toMatchObject({
      status: 400,
      problem: 'provider',
    });
    expect(await settings()).toEqual(before);
    const refreshed = await settings();
    expect(refreshed.provider).toBe('Processor B');
    expect(await saveAssistSettings(invoker, operator, form(refreshed.provider!))).toBeNull();
    expect(await settings()).toMatchObject({ enabled: true, consentedProvider: 'Processor B' });
  });

  it.each([undefined, '', 'Forged processor'])(
    'refuses missing/forged provider %s',
    async (provider) => {
      const { invoker, settings } = setup();
      const before = await settings();
      expect(await saveAssistSettings(invoker, operator, form(provider))).toMatchObject({
        status: 400,
        problem: 'provider',
      });
      expect(await settings()).toEqual(before);
    }
  );

  it.each(['Processor B', null])(
    'allows disabling after a change to %s without consent context',
    async (provider) => {
      const { invoker: initial, settings, deploy } = setup();
      let invoker = initial;
      await saveAssistSettings(invoker, operator, form('Processor A'));
      invoker = deploy(provider);
      expect(await saveAssistSettings(invoker, operator, new FormData())).toBeNull();
      expect(await settings()).toMatchObject({ enabled: false, consentedProvider: null });
    }
  );
});
