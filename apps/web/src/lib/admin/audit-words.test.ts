// Every command the Invoker can write to the log has its words (brief admin-operations-screens
// § 5): a new use case without them fails here, by name, instead of showing its technical name
// to an administrator. Queries are never audited, so they need none.

import { useCases } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { ui } from '../../i18n/index.js';
import { actorLabel, operationKey, resultKey } from './audit-words.js';

describe('audit words', () => {
  it('name every command of the registry', () => {
    const commands = Object.values(useCases)
      .filter((u) => u.kind === 'command')
      .map((u) => u.name);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((name) => operationKey(name) === null)).toEqual([]);
  });

  it('leave an unknown operation to its name and an unknown result to "failed"', () => {
    expect(operationKey('platform.set_status')).toBeNull();
    expect(resultKey('ok')).toBe('admin.audit.result.ok');
    expect(resultKey('something_new')).toBe('admin.audit.result.error');
  });

  it('name the actor when the page knows them, the kind in words when not', () => {
    const t = ui('nl');
    const names = { 'operator:o1': 'Sam' };
    expect(actorLabel(t, { actorKind: 'operator', actorId: 'o1' }, names)).toBe('Sam');
    expect(actorLabel(t, { actorKind: 'operator', actorId: 'gone' }, names)).toBe('Een lid');
    expect(actorLabel(t, { actorKind: 'anonymous', actorId: null }, names)).toBe('Een bezoeker');
  });
});
