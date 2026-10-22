import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_ENTITLEMENTS } from './entitlements/model.js';
import { UseCaseError } from './errors.js';
import { Invoker } from './invoke.js';
import { systemPrincipal } from './principal.js';
import { checkRegistry } from './registry-rules.js';
import type { UseCase } from './registry.js';
import { MemoryUnitOfWork, probeForm, probeTenant } from './testing/index.js';
import { buildRegistry } from './use-cases.js';

describe('registry conformance', () => {
  it('every registered use case satisfies the registry rules', () => {
    expect(checkRegistry(buildRegistry())).toEqual([]);
  });
});

// ADR 015: a use case that consumes a limit checks it. For each one, `examples[0]` runs on the
// probe tenant with that limit at zero and must be refused with `limit_exceeded`; with the
// defaults the same call must not be (it may fail for other reasons, the example being generic).
describe('a use case that consumes a limit checks it (ADR 015)', () => {
  const TENANT = '01900000-0000-7000-8000-00000000aaaa';
  const registry = buildRegistry();
  const consumers = registry.list().filter((u) => u.consumes);

  async function run(useCase: UseCase, entitlements = DEFAULT_ENTITLEMENTS): Promise<unknown> {
    const uow = new MemoryUnitOfWork();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.forms.insert(probeForm('01900000-0000-7000-8000-00000000f000'))
    );
    const principal = { ...systemPrincipal(TENANT, 'conformance'), entitlements };
    try {
      return await new Invoker(registry, uow).run(useCase, principal, useCase.examples[0].input);
    } catch (e) {
      return e;
    }
  }
  const limitExceeded = (r: unknown) => r instanceof UseCaseError && r.code === 'limit_exceeded';

  it('has consumers to check', () => {
    expect(consumers.map((u) => u.name).sort()).toEqual([
      'forms.submit',
      'tenant.hostnames.add',
      'tenant.members.invite',
    ]);
  });

  it.each(consumers.map((u) => [u.name, u] as const))(
    '%s is refused at a limit of zero and not with the defaults',
    async (_n, useCase) => {
      const limit = useCase.consumes!;
      expect(limitExceeded(await run(useCase, { ...DEFAULT_ENTITLEMENTS, [limit]: 0 }))).toBe(true);
      expect(limitExceeded(await run(useCase))).toBe(false);
    }
  );
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
    [
      'an unknown limit',
      { consumes: 'sites.max' as never },
      /consumes "sites.max", which is not a known limit/,
    ],
    [
      'a query that consumes',
      { kind: 'query' as const, consumes: 'supporters.max' as const },
      /a query cannot consume a limit/,
    ],
    [
      'content.item.create without consumes',
      { name: 'content.item.create' },
      /must declare consumes/,
    ],
    ['forms.submit without consumes', { name: 'forms.submit' }, /must declare consumes/],
  ])('rejects %s', (_label, override, rule) => {
    const found = violations(override as Partial<UseCase>);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(rule);
  });

  it('rejects duplicate names', () => {
    expect(violations({}, {})).toEqual(['content.item.update: name is not unique']);
  });

  it('accepts a growth verb that says it grows nothing, or names its limit', () => {
    expect(violations({ name: 'content.item.create', consumes: null })).toEqual([]);
    expect(violations({ name: 'media.file.upload', consumes: 'media.storage_max_bytes' })).toEqual(
      []
    );
  });

  it('accepts an effect with its own capability', () => {
    expect(
      violations({ name: 'mailing.issue.send', effect: 'send', requires: 'mailing:send' })
    ).toEqual([]);
  });
});
