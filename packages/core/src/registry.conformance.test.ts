import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkRegistry } from './registry-rules.js';
import type { UseCase } from './registry.js';
import { buildRegistry } from './use-cases.js';

describe('registry conformance', () => {
  it('every registered use case satisfies the registry rules', () => {
    expect(checkRegistry(buildRegistry())).toEqual([]);
  });

  // ADR 015: needs the entitlements model (TODO #16) before it can be a rule.
  it.todo('a use case that consumes a limit checks it (ADR 015)');
});

// The rules above pass vacuously unless each one is shown to catch a violation.
describe('registry rules catch violations', () => {
  const base: UseCase = {
    name: 'content.item.update',
    kind: 'command',
    description: 'Update an item.',
    requires: 'content:write',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async (_ctx, input) => input,
    examples: [{ input: { id: 'x' } }],
  };
  const violations = (...cases: Partial<UseCase>[]) =>
    checkRegistry({ list: () => cases.map((c) => ({ ...base, ...c }) as UseCase) });

  it('accepts the baseline', () => {
    expect(violations({})).toEqual([]);
  });

  it.each([
    ['a name outside the pattern', { name: 'Content.Item' }, /name does not match/],
    ['a single-segment name', { name: 'content' }, /name does not match/],
    ['an empty description', { description: ' ' }, /description is empty/],
    ['a description without a full stop', { description: 'Update' }, /full stop/],
    ['no examples', { examples: [] as unknown as UseCase['examples'] }, /has no examples/],
    ['an example that fails the schema', { examples: [{ input: { id: 1 } }] }, /examples\[0\]/],
    [
      'content.item.publish with content:write',
      {
        name: 'content.item.publish',
        effect: 'publish' as const,
        requires: 'content:write' as const,
      },
      /requires content:publish, not content:write/,
    ],
    [
      'mailing.issue.send without an effect',
      { name: 'mailing.issue.send', requires: 'mailing:send' as const },
      /must declare an effect/,
    ],
    [
      'a query with an effect',
      { kind: 'query' as const, effect: 'export' as const, requires: 'supporters:export' as const },
      /a query cannot have effect/,
    ],
    [
      'an input that is not an object',
      { input: z.string(), examples: [{ input: 'x' }] },
      /input is not an object/,
    ],
    ['an output that is not an object', { output: z.array(z.string()) }, /output is not an object/],
  ])('rejects %s', (_label, override, rule) => {
    const found = violations(override as Partial<UseCase>);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(rule);
  });

  it('rejects duplicate names', () => {
    expect(violations({}, {})).toEqual(['content.item.update: name is not unique']);
  });

  it('accepts an effect with its own capability', () => {
    expect(
      violations({ name: 'mailing.issue.send', effect: 'send', requires: 'mailing:send' })
    ).toEqual([]);
  });
});
