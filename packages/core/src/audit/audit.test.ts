import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import { Invoker } from '../invoke.js';
import type { UnitOfWork } from '../ports.js';
import { UseCaseRegistry, defineUseCase } from '../registry.js';
import {
  FakeClock,
  FakeInputHasher,
  MemoryErrorReporter,
  MemoryLogger,
  MemoryUnitOfWork,
  TENANT,
  adminOf,
  principal,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { canonicalJson } from '../util/canonical-json.js';
import { hashInput } from './model.js';

const HEX64 = /^[0-9a-f]{64}$/;

const echo = defineUseCase({
  name: 'test.echo',
  kind: 'command',
  description: 'Test command: answers with its input id.',
  requires: 'forms:write',
  input: z.object({ id: z.string(), note: z.string().optional() }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (_ctx, { id }) => ({ id }),
  examples: [{ input: { id: 'x' } }],
});
const failing = defineUseCase({
  ...echo,
  name: 'test.failing',
  description: 'Test command: throws from the handler.',
  handler: async () => {
    throw new Error('handler broke');
  },
});
const conflicting = defineUseCase({
  ...echo,
  name: 'test.conflicting',
  description: 'Test command: refuses with a use-case error.',
  handler: async () => {
    throw new UseCaseError('conflict', 'already there');
  },
});
const peek = defineUseCase({
  ...echo,
  name: 'test.peek',
  kind: 'query',
  description: 'Test query: answers with its input id.',
  requires: 'forms:read',
});

describe('canonical JSON and the input hash', () => {
  it('sorts keys at every depth and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}'
    );
  });

  it('gives the same hash for another key order, and another hash under another key', async () => {
    const hasher = new FakeInputHasher();
    const a = await hashInput(hasher, { email: 'a@example.org', list: 'news' });
    expect(a).toMatch(HEX64);
    expect(await hashInput(hasher, { list: 'news', email: 'a@example.org' })).toBe(a);
    expect(
      await hashInput(new FakeInputHasher('another-audit-key'), {
        email: 'a@example.org',
        list: 'news',
      })
    ).not.toBe(a);
  });

  it('hashes an input it cannot serialise as a marker instead of throwing', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await hashInput(new FakeInputHasher(), cyclic)).toMatch(HEX64);
  });
});

describe('the Invoker writes one audit row per command (TODO #17b)', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let log: MemoryLogger;
  let errors: MemoryErrorReporter;
  const registry = new UseCaseRegistry()
    .register(echo)
    .register(failing)
    .register(conflicting)
    .register(peek);
  const rows = () => uow.store.for(TENANT).audit;

  beforeEach(() => {
    uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    log = new MemoryLogger();
    errors = new MemoryErrorReporter();
    invoker = new Invoker(registry, uow, { requestId: () => 'req-1234abcd', log, errors });
  });

  it('records a success with actor, operation, hash, request id and subject', async () => {
    await invoker.run(echo, adminOf(), { id: 'thing-1' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      tenantId: TENANT,
      actorKind: 'system',
      actorId: 'test',
      operation: 'test.echo',
      effect: null,
      result: 'ok',
      requestId: 'req-1234abcd',
      subjectId: 'thing-1',
      inputHash: await hashInput(new FakeInputHasher(), { id: 'thing-1' }),
    });
  });

  it('records a refusal for want of a capability and rethrows it unchanged', async () => {
    const visitor = principal({ capabilities: ['forms:read'] });
    const error = await invoker.run(echo, visitor, { id: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UseCaseError);
    expect((error as UseCaseError).code).toBe('forbidden');
    expect(rows().map((r) => r.result)).toEqual(['forbidden']);
  });

  it('records a suspended tenant as suspended', async () => {
    const suspended = principal({ tenantStatus: 'suspended' });
    await expect(invoker.run(echo, suspended, { id: 'x' })).rejects.toMatchObject({
      code: 'suspended',
    });
    expect(rows().map((r) => r.result)).toEqual(['suspended']);
  });

  it('hashes the raw input when it does not parse', async () => {
    const raw = { id: 7, extra: true };
    await expect(invoker.call(adminOf(), 'test.echo', raw)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      result: 'invalid_input',
      inputHash: await hashInput(new FakeInputHasher(), raw),
    });
  });

  it('records a use-case error by its code and anything else as error, original error first', async () => {
    await expect(invoker.run(conflicting, adminOf(), { id: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(invoker.run(failing, adminOf(), { id: 'x' })).rejects.toThrow('handler broke');
    expect(rows().map((r) => [r.operation, r.result])).toEqual([
      ['test.conflicting', 'conflict'],
      ['test.failing', 'error'],
    ]);
  });

  it('does not audit queries', async () => {
    await invoker.run(peek, adminOf(), { id: 'x' });
    expect(rows()).toEqual([]);
  });

  it('names an operator by id, never by address', async () => {
    const operator = principal({
      actor: { kind: 'operator', operatorId: 'op-1', email: 'editor@example.org' },
    });
    await invoker.run(echo, operator, { id: 'x' });
    expect(rows()[0]).toMatchObject({ actorKind: 'operator', actorId: 'op-1' });
    expect(JSON.stringify(rows())).not.toContain('@');
  });

  it('keeps the original error when the refusal row cannot be written, and reports that', async () => {
    const broken: UnitOfWork = {
      run: (principal, fn) =>
        uow.run(principal, (ctx) =>
          fn({
            ...ctx,
            audit: {
              ...ctx.audit,
              record: () => Promise.reject(new Error('audit table gone')),
            },
          })
        ),
    };
    const brokenInvoker = new Invoker(registry, broken, { log, errors });
    await expect(brokenInvoker.run(failing, adminOf(), { id: 'x' })).rejects.toThrow(
      'handler broke'
    );
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'audit: could not record a command' })
    );
    expect(errors.captured.map((c) => (c.error as Error).message)).toEqual(['audit table gone']);
  });

  it('turns a success into an error row when its own row cannot be written', async () => {
    let calls = 0;
    const flaky: UnitOfWork = {
      run: (principal, fn) =>
        uow.run(principal, (ctx) =>
          fn({
            ...ctx,
            audit: {
              ...ctx.audit,
              record: (entry) =>
                calls++ === 0
                  ? Promise.reject(new Error('insert failed'))
                  : ctx.audit.record(entry),
            },
          })
        ),
    };
    await expect(new Invoker(registry, flaky).run(echo, adminOf(), { id: 'x' })).rejects.toThrow(
      'insert failed'
    );
    expect(rows().map((r) => r.result)).toEqual(['error']);
  });
});

describe('audit.list', () => {
  let uow: MemoryUnitOfWork;
  let clock: FakeClock;
  let invoker: Invoker;

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    for (const name of ['a', 'b', 'c']) {
      await invoker
        .run(useCases.createKey, adminOf(), { name, capabilities: ['content:read'] })
        .catch(() => undefined);
      clock.advance(1000);
    }
  });

  it('pages newest first, without the input hash', async () => {
    const first = await invoker.run(useCases.listAudit, adminOf(), { limit: 2 });
    expect(first.items.map((r) => r.operation)).toEqual(['tenant.key.create', 'tenant.key.create']);
    expect(first.items[0]).not.toHaveProperty('inputHash');
    expect(first.nextCursor).toBe(first.items[1]!.id);
    const rest = await invoker.run(useCases.listAudit, adminOf(), {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(Date.parse(rest.items[0]!.occurredAt)).toBeLessThan(
      Date.parse(first.items[1]!.occurredAt)
    );
  });

  it('filters by operation, actor and period, and needs tenant:admin', async () => {
    const all = await invoker.run(useCases.listAudit, adminOf(), {});
    const middle = all.items[1]!.occurredAt;
    expect(
      (await invoker.run(useCases.listAudit, adminOf(), { operation: 'media.upload' })).items
    ).toEqual([]);
    expect(
      (await invoker.run(useCases.listAudit, adminOf(), { actorKind: 'system', actorId: 'test' }))
        .items
    ).toHaveLength(3);
    expect(
      (await invoker.run(useCases.listAudit, adminOf(), { from: middle })).items.map((r) => r.id)
    ).toEqual(all.items.slice(0, 2).map((r) => r.id));
    await expect(
      invoker.run(useCases.listAudit, principal({ capabilities: ['content:write'] }), {})
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
