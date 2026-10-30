import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentDocumentInput } from './content/model.js';
import { DEFAULT_ENTITLEMENTS } from './entitlements/model.js';
import { UseCaseError } from './errors.js';
import { Invoker } from './invoke.js';
import { toJsonSchema } from './json-schema.js';
import { anonymousPrincipal, Capability, systemPrincipal, type Principal } from './principal.js';
import { checkRegistry } from './registry-rules.js';
import type { UseCase } from './registry.js';
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
// anything. Run with the entitlement off and with no pending room, `examples[0]` must be refused
// with the gate's own issue, on ids that do not exist; a command that checks later, or not at all,
// answers `not_found` or succeeds instead. The second case shows the check is not vacuous.
describe('every ai:assist command passes the assistance gate (ADR 015)', () => {
  const registry = buildRegistry();
  const assisted = registry.list().filter((u) => u.requires === 'ai:assist');

  async function refusal(useCase: UseCase, entitlements: Principal['entitlements']) {
    const uow = new MemoryUnitOfWork();
    uow.store.addPlatformHostname(probeTenant(TENANT), uow.platform.domain);
    const caller = principal({ entitlements });
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
    (await refusal(useCase, { ...DEFAULT_ENTITLEMENTS, 'ai.pending_max': 0 })) !==
      'limit_exceeded assist.error.limit-reached';

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

// Drafts, revisions and author e-mail never reach a public visitor, even one handed every
// capability: `authenticatedOnly` is checked before capabilities, in the one Invoker every
// front uses.
describe('editorial use cases refuse anonymous principals', () => {
  const registry = buildRegistry();
  const editorial = registry.list().filter((u) => u.authenticatedOnly);
  it('has editorial use cases to check', () => expect(editorial.length).toBeGreaterThan(0));
  it.each(editorial.map((u) => [u.name, u] as const))(
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

// The rules above pass vacuously unless each one is shown to catch a violation.
describe('registry rules catch violations', () => {
  const base: UseCase = {
    name: 'content.item.update',
    kind: 'command',
    description: 'Update an item.',
    requires: 'content:write',
    authenticatedOnly: true,
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
    ['form.submit without consumes', { name: 'form.submit' }, /must declare consumes/],
    ['a plural module', { name: 'connections.get' }, /module "connections" is not in MODULES/],
    ['a plural entity', { name: 'tenant.members.list' }, /entity "members" is plural/],
    ['a verb outside the list', { name: 'site.brand.put' }, /verb "put" is not in VERBS/],
    ['a noun as the verb', { name: 'content.item.revisions' }, /verb "revisions"/],
    ['four segments', { name: 'content.item.translation.approve' }, /more than three segments/],
    [
      'an editorial use case open to anonymous principals',
      { authenticatedOnly: false },
      /must be authenticatedOnly/,
    ],
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

// TODO #17b: every command leaves exactly one audit row, whatever the outcome, with a keyed hash
// and no address in any column. Runs every command of the registry, so a new command is covered
// without a new test.
describe('every command leaves exactly one audit row (TODO #17b)', () => {
  const registry = buildRegistry();
  const commands = registry.list().filter((u) => u.kind === 'command');
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
      actor: { kind: 'operator', operatorId: 'op-conformance', email: 'operator@example.org' },
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
