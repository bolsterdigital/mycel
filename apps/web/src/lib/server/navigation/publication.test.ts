// Where the draft of each locale stands on the navigation overview: a draft that is live says
// "same as live" even when one of its targets went offline since (there is no new revision to
// refuse), and only a draft ahead of the live one is checked and can be "cannot be published".
// The preview lists an anchor on a part that shows nothing with core's problems, never blocking.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@mycel/core';
import { localeStates, previewModel } from './publication.js';

const checked: string[] = [];
const invoker = {
  run: vi.fn(async (_useCase: unknown, _principal: unknown, input: { locale: string }) => {
    checked.push(input.locale);
    return { problems: [{ code: 'target-unknown', blocking: true }] };
  }),
};
vi.mock('../runtime.js', () => ({ runtime: () => ({ invoker }) }));

const principal = {} as Principal;
const at = '2026-11-15T10:00:00.000Z';
const state = (revisionId: string | null, publication: { locale: string; revisionId: string }[]) =>
  ({
    revisionId,
    publication: publication.map((p) => ({ ...p, publishedAt: at })),
  }) as unknown as Parameters<typeof localeStates>[1];

beforeEach(() => {
  checked.length = 0;
});

describe('localeStates', () => {
  it('calls a live draft the same as live, whatever its targets did since', async () => {
    const states = await localeStates(
      principal,
      state('r2', [{ locale: 'nl', revisionId: 'r2' }]),
      ['nl']
    );
    expect(states).toEqual([
      { locale: 'nl', live: { revisionId: 'r2', publishedAt: at }, draft: 'same' },
    ]);
    expect(checked).toEqual([]);
  });

  it('checks a draft ahead of the live one, or with nothing live, and says it is blocked', async () => {
    const states = await localeStates(
      principal,
      state('r2', [{ locale: 'nl', revisionId: 'r1' }]),
      ['nl', 'en']
    );
    expect(states.map((s) => [s.locale, s.draft])).toEqual([
      ['nl', 'blocked'],
      ['en', 'blocked'],
    ]);
    expect(checked.sort()).toEqual(['en', 'nl']);
  });

  it('calls a draft that nothing refuses ahead, and no navigation at all the same', async () => {
    invoker.run.mockResolvedValueOnce({
      problems: [{ code: 'target-unavailable', blocking: false }],
    });
    const [ahead] = await localeStates(principal, state('r2', []), ['nl']);
    expect(ahead?.draft).toBe('ahead');
    const [none] = await localeStates(principal, state(null, []), ['nl']);
    expect(none).toEqual({ locale: 'nl', live: null, draft: 'same' });
  });
});

describe('previewModel', () => {
  it('lists an anchor on a part that shows nothing as a problem that does not block', () => {
    const document = {
      menus: [{ id: 'main', name: 'Hoofdmenu', nodes: [] }],
      placements: { main: null, actions: null, footer: [], legal: null },
    };
    const check = {
      revisionId: 'r1',
      nodes: [{ menuId: 'main', nodeId: 'n1', label: 'Doel', source: 'own', target: 'ok' }],
      preview: { main: null, actions: [], footer: [], legal: null },
      problems: [],
    };
    const model = previewModel(
      document as unknown as Parameters<typeof previewModel>[0],
      check as unknown as Parameters<typeof previewModel>[1],
      'nl',
      'nl',
      [{ menuId: 'main', nodeId: 'n1' }]
    );
    expect(model.problems).toEqual([
      { menu: 'Hoofdmenu', item: 'Doel', code: 'anchor-empty', blocking: false },
    ]);
    expect(model.blocked).toBe(false);
  });
});
