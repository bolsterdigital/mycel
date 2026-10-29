// The commit boundary of a use case against Postgres (probe-herstel A): the Invoker validates a
// handler's output inside the unit of work, so output that does not match the schema rolls back
// everything the handler wrote, its own rows and its outbox events alike. The memory adapter is
// not transactional and cannot show this; only the database can.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Invoker, UseCaseRegistry, defineUseCase, systemPrincipal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  probeForm,
  runSuffix,
  adminOf,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids } from './index.js';
import { closeTenantWork, requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

/** Writes one tenant row and one outbox event, then returns output that is valid or not. */
const writeThenAnswer = defineUseCase({
  name: 'test.write.then.answer',
  kind: 'command',
  description: 'Test command: writes a form and an event, then answers with the requested output.',
  requires: 'forms:write',
  input: z.object({ formId: z.string(), eventId: z.string(), validOutput: z.boolean() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { formId, eventId, validOutput }) => {
    await ctx.forms.insert(probeForm(formId));
    await ctx.events.publish({
      id: eventId,
      type: 'test.written',
      tenantId: ctx.principal.tenantId,
      occurredAt: ctx.clock.now(),
      actor: ctx.principal.actor,
      props: { formId },
    });
    return (validOutput ? { id: formId } : { id: 42 }) as { id: string };
  },
  examples: [{ input: { formId: 'f', eventId: 'e', validOutput: true } }],
});

describe.skipIf(skip)('invoke conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(new UseCaseRegistry().register(writeThenAnswer), uow);
  const run = runSuffix();
  let tenantId = '';

  /** What the transaction left behind: the form (read under RLS) and the outbox row. */
  const leftBehind = async (formId: string, eventId: string) => ({
    form: await uow.run(adminOf(tenantId), (ctx) => ctx.forms.findById(formId)),
    outbox: await operatorDb
      .selectFrom('outbox')
      .select('id')
      .where('id', '=', eventId)
      .executeTakeFirst(),
  });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenantId = (await testTenant(operatorDb, `invoke-${run}`, { name: 'I' })).id;
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantId]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('rolls back the handler and its outbox event when the output is invalid', async () => {
    const formId = uuidv7();
    const eventId = uuidv7();
    await expect(
      invoker.run(writeThenAnswer, adminOf(tenantId), { formId, eventId, validOutput: false })
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(await leftBehind(formId, eventId)).toEqual({ form: null, outbox: undefined });
  });

  it('commits the handler and its outbox event when the output is valid', async () => {
    const formId = uuidv7();
    const eventId = uuidv7();
    expect(
      await invoker.run(writeThenAnswer, adminOf(tenantId), { formId, eventId, validOutput: true })
    ).toEqual({ id: formId });
    const after = await leftBehind(formId, eventId);
    expect(after.form?.id).toBe(formId);
    expect(after.outbox).toEqual({ id: eventId });
  });

  // TODO #17b: a command's audit row commits with it. The invalid output rolls back the `ok` row
  // with everything else, and the refusal gets its own `error` row after the rollback.
  it('writes the ok row in the command transaction and the error row after its rollback', async () => {
    const audit = () =>
      uow.run(adminOf(tenantId), (ctx) =>
        ctx.audit.list({ operation: writeThenAnswer.name, limit: 100 })
      );
    const before = (await audit()).length;
    const formId = uuidv7();
    await expect(
      invoker.run(writeThenAnswer, adminOf(tenantId), {
        formId,
        eventId: uuidv7(),
        validOutput: false,
      })
    ).rejects.toBeInstanceOf(z.ZodError);
    const afterFailure = await audit();
    expect(afterFailure.length - before).toBe(1);
    expect(afterFailure[0]).toMatchObject({ result: 'error', subjectId: null });

    await invoker.run(writeThenAnswer, adminOf(tenantId), {
      formId: uuidv7(),
      eventId: uuidv7(),
      validOutput: true,
    });
    const afterSuccess = await audit();
    expect(afterSuccess.length - before).toBe(2);
    expect(afterSuccess[0]).toMatchObject({ result: 'ok', actorKind: 'system', actorId: 'test' });
  });
});
