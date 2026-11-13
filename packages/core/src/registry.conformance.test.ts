import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentDocumentInput } from './content/model.js';
import { DEFAULT_ENTITLEMENTS } from './entitlements/model.js';
import { UseCaseError } from './errors.js';
import { Invoker } from './invoke.js';
import { toJsonSchema } from './json-schema.js';
import {
  anonymousPrincipal,
  Capability,
  offeredCapabilities,
  PLANNED_CAPABILITIES,
  systemPrincipal,
  type Principal,
} from './principal.js';
import { checkRegistry } from './registry-rules.js';
import { UNAUDITED_COMMANDS } from './registry.js';
import { ANONYMOUS_USE_CASES, type UseCase } from './registry.js';
import { MemoryUnitOfWork, TENANT, principal, probeForm, probeTenant } from './testing/index.js';
import { buildRegistry, useCases } from './use-cases.js';

describe('registry conformance', () => {
  it('every registered use case satisfies the registry rules', () => {
    expect(checkRegistry(buildRegistry())).toEqual([]);
  });
});

// Dependency upgrades must keep the stored/wire vocabulary while refusing an oversized
// constrained collection before walking its attacker-controlled elements (GHSA-mrhx-c7xc-m3w5).
describe('validation boundary', () => {
  const document = {
    type: 'article',
    title: { en: 'A title' },
    defaultLocale: 'en',
    locales: ['en'],
    blocks: [],
  };

  it('parses nested defaults instead of returning an incomplete default object', () => {
    expect(ContentDocumentInput.parse(document)).toMatchObject({
      seo: { noindex: false },
      access: { level: 'public', teaser: 'lead' },
      delivery: { web: true },
      authorIds: [],
      sectionId: null,
      tags: [],
      corrections: [],
    });
    expect(ContentDocumentInput.safeParse({ ...document, seo: { css: 'injected' } }).success).toBe(
      false
    );
  });

  it('keeps existing GUID-shaped ids and the UUID wire label', () => {
    // Zod 3 uuid() accepted this shape without checking the version and variant bits.
    const id = '12345678-1234-0000-0000-123456789abc';
    expect(useCases.getItem.input.parse({ itemId: id })).toEqual({ itemId: id });
    expect(useCases.getItem.input.safeParse({ itemId: 'not-an-id' }).success).toBe(false);
    expect(toJsonSchema(useCases.getItem.input, 'input').properties).toMatchObject({
      itemId: { type: 'string', format: 'uuid' },
    });
  });

  it('rejects an oversized block array before reading any block', () => {
    const block = {
      get type(): string {
        throw new Error('oversized collection was traversed');
      },
    };
    const result = ContentDocumentInput.safeParse({
      ...document,
      blocks: Array.from({ length: 1001 }, () => block),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'too_big', path: ['blocks'], maximum: 1000 }),
      ]);
  });
});

// ADR 015: a use case that consumes a limit checks it. For each one, `examples[0]` runs on the
// probe tenant with that limit at zero and must be refused with `limit_exceeded`; with the
// defaults the same call must not be (it may fail for other reasons, the example being generic).
describe('a use case that consumes a limit checks it (ADR 015)', () => {
  const registry = buildRegistry();
  const consumers = registry.list().filter((u) => u.consumes);

  async function run(useCase: UseCase, entitlements = DEFAULT_ENTITLEMENTS): Promise<unknown> {
    const uow = new MemoryUnitOfWork();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.forms.insert(probeForm('01900000-0000-7000-8000-00000000f000'))
    );
    const caller = principal({ entitlements });
    try {
      return await new Invoker(registry, uow).run(useCase, caller, useCase.examples[0].input);
    } catch (e) {
      return e;
    }
  }
  const limitExceeded = (r: unknown) => r instanceof UseCaseError && r.code === 'limit_exceeded';

  it('has consumers to check', () => {
    expect(consumers.map((u) => u.name).sort()).toEqual([
      'assist.alt.suggest',
      'assist.translation.suggest',
      'form.submit',
      'media.upload',
      'tenant.hostname.add',
      'tenant.member.invite',
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

// ADR 015, TODO #53: every `ai:assist` command passes the one assistance gate before it reads
// anything. Run with the entitlement off and with each of its three limits at zero (month, pending,
// operator per hour), `examples[0]` must be refused with the gate's own issue, on ids that do not
// exist; a command that checks later, or not at all, answers `not_found` or succeeds instead.
// The second case shows the check is not vacuous.
describe('every ai:assist command passes the assistance gate (ADR 015)', () => {
  const registry = buildRegistry();
  const assisted = registry.list().filter((u) => u.requires === 'ai:assist');

  // An operator, because the hourly throttle counts per operator and passes over system actors.
  const operator = { kind: 'operator', operatorId: 'op-gate' } as const;
  async function refusal(useCase: UseCase, entitlements: Principal['entitlements']) {
    const uow = new MemoryUnitOfWork();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    const caller = principal({ entitlements, actor: operator });
    const reg = buildRegistry();
    if (!reg.get(useCase.name)) reg.register(useCase);
    try {
      await new Invoker(reg, uow).run(useCase, caller, useCase.examples[0].input);
      return null;
    } catch (e) {
      return e instanceof UseCaseError ? `${e.code} ${e.issues[0]?.message ?? ''}` : String(e);
    }
  }
  const ungated = async (useCase: UseCase) =>
    (await refusal(useCase, { ...DEFAULT_ENTITLEMENTS, 'ai.assist': false })) !==
      'limit_exceeded assist.error.ai-not-entitled' ||
    (
      await Promise.all(
        (['ai.monthly_max', 'ai.pending_max', 'ai.operator_hourly_max'] as const).map((limit) =>
          refusal(useCase, { ...DEFAULT_ENTITLEMENTS, [limit]: 0 })
        )
      )
    ).some((r) => r !== 'limit_exceeded assist.error.limit-reached');

  it('has assisted commands to check', () => {
    expect(assisted.map((u) => u.name).sort()).toEqual([
      'assist.alt.suggest',
      'assist.translation.suggest',
    ]);
  });

  it.each(assisted.map((u) => [u.name, u] as const))('%s is gated', async (_n, useCase) => {
    expect(await ungated(useCase)).toBe(false);
  });

  it('flags an ai:assist command that skips the gate', async () => {
    const [first] = assisted;
    const skips: UseCase = {
      ...first!,
      name: 'assist.ungated.suggest',
      handler: async () => ({
        suggestionId: '01900000-0000-7000-8000-000000000001',
        status: 'pending',
      }),
    };
    expect(await ungated(skips)).toBe(true);
  });
});

// A capability an operator can grant has to limit something (ADR 018 rule 5), or say why not yet.
describe('every capability is required by a use case or planned with a reason', () => {
  const required = new Set(
    buildRegistry()
      .list()
      .map((u) => u.requires)
  );
  const planned = Object.keys(PLANNED_CAPABILITIES) as Capability[];

  it('leaves no capability without a use case or a reason', () => {
    expect(Capability.options.filter((c) => !required.has(c) && !planned.includes(c))).toEqual([]);
  });
  it('lists no capability that has a use case by now', () => {
    expect(planned.filter((c) => required.has(c))).toEqual([]);
  });
  it('offers a planned capability only to a set that already holds it', () => {
    expect(offeredCapabilities()).not.toContain('money:refund');
    expect(offeredCapabilities()).toContain('mailing:send');
    expect(offeredCapabilities()).toContain('content:read');
    expect(offeredCapabilities(['mailing:send'])).toContain('mailing:send');
    expect(offeredCapabilities(['mailing:send'])).not.toContain('money:refund');
  });
});

// A public visitor reaches the allowlist and nothing else, even when handed every capability: it
// is checked before capabilities, in the one Invoker every front uses.
describe('use cases outside the allowlist refuse anonymous principals', () => {
  const registry = buildRegistry();
  const closed = registry.list().filter((u) => !ANONYMOUS_USE_CASES.has(u.name));
  it('has no allowlist entry without a use case', () => {
    const names = registry.list().map((u) => u.name);
    expect([...ANONYMOUS_USE_CASES].filter((name) => !names.includes(name))).toEqual([]);
  });
  it('closes a use case that nobody listed', () => {
    const fresh = { ...closed[0]!, name: 'content.item.brand_new', requires: 'content:read' };
    const visitor = anonymousPrincipal('01900000-0000-7000-8000-00000000aaaa', ['content:read']);
    expect(registry.authorize(fresh as UseCase, visitor)).toBe(false);
  });
  it.each(closed.map((u) => [u.name, u] as const))(
    '%s refuses an anonymous principal with every capability',
    async (_name, useCase) => {
      const invoker = new Invoker(registry, new MemoryUnitOfWork());
      const visitor = anonymousPrincipal(
        '01900000-0000-7000-8000-00000000aaaa',
        Capability.options
      );
      await expect(
        invoker.call(visitor, useCase.name, useCase.examples[0].input)
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
  );
});

// The registry gate itself, apart from any handler: `alsoRequires` is all of them, never any.
// The API and MCP conformance show the same per front, but a real handler may refuse on its own.
describe('alsoRequires: the gate wants every capability', () => {
  const registry = buildRegistry();
  const both = {
    ...registry.list().find((u) => u.requires === 'content:write' && !u.actors)!,
    alsoRequires: ['forms:write'],
  } as UseCase;
  const member = (capabilities: Capability[]) =>
    principal({ actor: { kind: 'api-key', keyId: 'gate' }, capabilities });
  it.each([[[]], [['content:write']], [['forms:write']]] as Capability[][][])(
    'refuses %j',
    (capabilities) => expect(registry.authorize(both, member(capabilities))).toBe(false)
  );
  it('admits both', () => {
    expect(registry.authorize(both, member(['content:write', 'forms:write']))).toBe(true);
  });
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
    [
      'an unaudited use case that is a query',
      { name: 'content.presence.update', kind: 'query' as const },
      /unaudited/,
    ],
    [
      'an unaudited command with an effect',
      {
        name: 'content.presence.update',
        effect: 'publish' as const,
        requires: 'content:publish' as const,
      },
      /unaudited/,
    ],
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
      'supporter.erase without an effect',
      { name: 'supporter.erase', requires: 'supporters:erase' as const },
      /must declare an effect/,
    ],
    [
      'an erasure under supporters:write',
      { name: 'supporter.erase', effect: 'erase' as const, requires: 'supporters:write' as const },
      /requires supporters:erase, not supporters:write/,
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
    ['form.submit without consumes', { name: 'form.submit' }, /must declare consumes/],
    ['a plural module', { name: 'connections.get' }, /module "connections" is not in MODULES/],
    ['a plural entity', { name: 'tenant.members.list' }, /entity "members" is plural/],
    ['a verb outside the list', { name: 'site.brand.put' }, /verb "put" is not in VERBS/],
    ['a noun as the verb', { name: 'content.item.revisions' }, /verb "revisions"/],
    ['four segments', { name: 'content.item.translation.approve' }, /more than three segments/],
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

  it('accepts an effect with its own capability, or with tenant:admin', () => {
    expect(
      violations({ name: 'mailing.issue.send', effect: 'send', requires: 'mailing:send' })
    ).toEqual([]);
    expect(
      violations({ name: 'tenant.archive.export', effect: 'export', requires: 'tenant:admin' })
    ).toEqual([]);
  });
});

// Postgres refuses a NUL in `text` and `jsonb`. The Invoker refuses it first, for every use case,
// so a `%00` is a 400 and never a 500 from the adapter.
describe('a NUL in any text input is invalid input and reaches no handler', () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  // Open to any actor, because this is about the text and not about who sends it.
  const unreachable = ({ actors: _anyone, ...useCase }: UseCase): UseCase => ({
    ...useCase,
    handler: () => Promise.reject(new Error(`${useCase.name} reached its handler`)),
  });

  /** Every copy of `value` with one of its strings ending in a NUL. */
  function withNul(value: unknown): unknown[] {
    if (typeof value === 'string') return [`${value}\0`];
    if (Array.isArray(value))
      return value.flatMap((item, i) =>
        withNul(item).map((changed) => value.map((old, j) => (j === i ? changed : old)))
      );
    if (typeof value === 'object' && value !== null)
      return Object.entries(value).flatMap(([key, item]) =>
        withNul(item).map((changed) => ({ ...value, [key]: changed }))
      );
    return [];
  }

  const cases = buildRegistry()
    .list()
    .flatMap((u) =>
      u.examples.flatMap((example) =>
        withNul(example.input).map((input) => [u.name, u, input] as const)
      )
    );

  it('has text inputs to check, across the register', () => {
    expect(cases.length).toBeGreaterThan(100);
    expect(new Set(cases.map(([name]) => name)).size).toBeGreaterThan(50);
  });

  it.each(cases)('%s', async (_name, useCase, input) => {
    await expect(
      invoker.run(unreachable(useCase), principal({ capabilities: Capability.options }), input)
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  describe('wherever the schema lets it through', () => {
    const probe = (input: z.ZodTypeAny) =>
      ({
        ...useCases.getItem,
        input,
        handler: () => Promise.reject(new Error('reached')),
      }) as UseCase;
    const run = (schema: z.ZodTypeAny, input: unknown) =>
      invoker.run(probe(schema), principal({ capabilities: Capability.options }), input);
    const refused = { code: 'invalid_input' };

    it('an optional field, a nested one, an array element and free JSON', async () => {
      await expect(run(z.object({ a: z.string().optional() }), { a: 'x\0' })).rejects.toMatchObject(
        {
          ...refused,
          issues: [{ path: 'a' }],
        }
      );
      await expect(
        run(z.object({ a: z.object({ b: z.array(z.string()) }) }), { a: { b: ['ok', 'x\0'] } })
      ).rejects.toMatchObject({ ...refused, issues: [{ path: 'a.b.1' }] });
      await expect(
        run(z.record(z.string(), z.unknown()), { a: [{ b: '\0' }] })
      ).rejects.toMatchObject({
        ...refused,
        issues: [{ path: 'a.0.b' }],
      });
    });

    it('a key', async () => {
      await expect(run(z.record(z.string(), z.number()), { 'a\0': 1 })).rejects.toMatchObject(
        refused
      );
    });

    it('not a key the schema strips, and not the bytes of an upload', async () => {
      await expect(run(z.object({ a: z.number() }), { a: 1, 'b\0': 'x\0' })).rejects.toThrow(
        'reached'
      );
      await expect(run(z.instanceof(Uint8Array), new Uint8Array([0]))).rejects.toThrow('reached');
    });

    it('a list filter that a transform hands on', async () => {
      await expect(
        invoker.run(
          useCases.listItems as unknown as UseCase,
          principal({ capabilities: Capability.options }),
          { tag: 'x\0' }
        )
      ).rejects.toMatchObject({ ...refused, issues: [{ path: 'tag' }] });
    });

    it('asks for the capability before it reads the text', async () => {
      await expect(
        invoker.run(useCases.getItem as unknown as UseCase, principal({ capabilities: [] }), {
          itemId: 'x\0',
        })
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});

// TODO #17b: every command leaves exactly one audit row, whatever the outcome, with a keyed hash
// and no address in any column. Runs every command of the registry, so a new command is covered
// without a new test.
describe('every command leaves exactly one audit row (TODO #17b)', () => {
  const registry = buildRegistry();
  const commands = registry
    .list()
    .filter((u) => u.kind === 'command' && !UNAUDITED_COMMANDS.has(u.name));
  const HEX64 = /^[0-9a-f]{64}$/;

  async function setup() {
    const uow = new MemoryUnitOfWork();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    await uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.forms.insert(probeForm('01900000-0000-7000-8000-00000000f000'))
    );
    // A real member: the member and key commands read the acting operator again (TODO #20a).
    uow.store.operators.set('op-conformance', {
      id: 'op-conformance',
      issuer: null,
      subject: null,
      email: 'operator@example.org',
      emailVerifiedAt: null,
      name: null,
      lastLoginAt: null,
    });
    uow.store.for(TENANT).members.set('op-conformance', {
      capabilities: ['tenant:admin'],
      createdAt: new Date(0),
    });
    return { uow, invoker: new Invoker(registry, uow), rows: () => uow.store.for(TENANT).audit };
  }
  // An operator carries an address; the rows must not.
  const operator = (capabilities: Principal['capabilities']): Principal =>
    principal({
      actor: { kind: 'operator', operatorId: 'op-conformance' },
      capabilities,
    });
  const noAddress = (rows: unknown[]) =>
    expect(JSON.stringify(rows), 'an audit column holds an address').not.toContain('@');

  it('has commands to check', () => {
    expect(commands.length).toBeGreaterThan(10);
  });

  it.each(commands.map((u) => [u.name, u] as const))(
    '%s refused for want of its capability: one forbidden row',
    async (_n, useCase) => {
      const { invoker, rows } = await setup();
      await expect(
        invoker.run(useCase, operator([]), useCase.examples[0].input)
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        operation: useCase.name,
        effect: useCase.effect ?? null,
        result: 'forbidden',
        actorKind: 'operator',
        actorId: 'op-conformance',
      });
      expect(rows()[0]!.inputHash).toMatch(HEX64);
      noAddress(rows());
    }
  );

  // With every capability, so the success path is the real one: an example
  // that needs state the probe fixture lacks still fails, but never for want of a right.
  const succeeded: string[] = [];
  it.each(commands.map((u) => [u.name, u] as const))(
    '%s run with its example: one row, ok exactly when it succeeded',
    async (_n, useCase) => {
      const { invoker, rows } = await setup();
      const outcome = await invoker
        .run(useCase, operator(Capability.options), useCase.examples[0].input)
        .then(
          () => 'ok',
          (e: unknown) => (e instanceof UseCaseError ? e.code : 'error')
        );
      if (outcome === 'ok') succeeded.push(useCase.name);
      expect(outcome).not.toBe('forbidden');
      expect(rows().map((r) => [r.operation, r.result])).toEqual([[useCase.name, outcome]]);
      expect(rows()[0]!.inputHash).toMatch(HEX64);
      noAddress(rows());
    }
  );

  it('proves the ok row for the commands whose example runs on the probe fixture', () => {
    expect(succeeded).toEqual(
      expect.arrayContaining(['content.item.create', 'form.submit', 'tenant.key.create'])
    );
  });
});
