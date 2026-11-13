// The presence rules (ADR 029) over the memory store: expiry, one line per actor, the asker's own
// tab, the newer-revision signal, the capability, the tenant boundary and the absence of an audit
// row. Postgres (RLS, the sweep, the upsert) is in packages/db/src/presence.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import type { Capability, Principal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { PRESENCE_TTL_MS } from './model.js';

const OTHER = '01900000-0000-7000-8000-00000000b124';
const TAB_A = '01900000-0000-7000-8000-0000000000a1';
const TAB_A2 = '01900000-0000-7000-8000-0000000000a2';
const TAB_B = '01900000-0000-7000-8000-0000000000b1';

const as = (
  operatorId: string,
  tenantId: string = TENANT,
  capabilities: Capability[] = ['content:read', 'content:write']
): Principal =>
  principal({
    tenantId,
    capabilities,
    actor: { kind: 'operator', operatorId },
  });

describe('content presence (ADR 029)', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let itemId: string;
  let firstRevision: string;
  const anna = as('anna');
  const ben = as('ben');
  const beat = (who: Principal, sessionId: string, state: 'viewing' | 'editing', base?: string) =>
    invoker.run(useCases.updatePresence, who, {
      itemId,
      sessionId,
      state,
      ...(base ? { baseRevisionId: base } : {}),
    });

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    const made = await invoker.run(useCases.createItem, as('anna'), {
      ...useCases.createItem.examples[0].input,
    });
    itemId = made.item.id;
    firstRevision = made.revision.id;
  });

  it('tells viewing from editing, and leaves out the tab that asks', async () => {
    await beat(anna, TAB_A, 'editing');
    const seen = await beat(ben, TAB_B, 'viewing');
    expect(seen.present).toEqual([{ actor: anna.actor, state: 'editing', self: false }]);
    const back = await beat(anna, TAB_A, 'editing');
    expect(back.present).toEqual([{ actor: ben.actor, state: 'viewing', self: false }]);
  });

  it('shows one line per actor, editing when any of their tabs is', async () => {
    await beat(anna, TAB_A, 'viewing');
    await beat(anna, TAB_A2, 'editing');
    const seen = await beat(ben, TAB_B, 'viewing');
    expect(seen.present).toEqual([{ actor: anna.actor, state: 'editing', self: false }]);
  });

  it("names the asker's other window as themselves", async () => {
    await beat(anna, TAB_A2, 'editing');
    const seen = await beat(anna, TAB_A, 'viewing');
    expect(seen.present).toEqual([{ actor: anna.actor, state: 'editing', self: true }]);
  });

  it('forgets a tab that stopped reporting, without anyone doing anything', async () => {
    await beat(anna, TAB_A, 'editing');
    clock.advance(PRESENCE_TTL_MS - 1);
    expect((await beat(ben, TAB_B, 'viewing')).present).toHaveLength(1);
    clock.advance(2);
    expect((await beat(ben, TAB_B, 'viewing')).present).toEqual([]);
  });

  it('signals a newer revision to a tab on an older base, and never as a conflict', async () => {
    expect((await beat(ben, TAB_B, 'viewing', firstRevision)).newer).toBeNull();
    const saved = await invoker.run(useCases.setBlockProps, anna, {
      ...(await firstBlockEdit(invoker, anna, itemId, firstRevision)),
    });
    const seen = await beat(ben, TAB_B, 'viewing', firstRevision);
    expect(seen.newer).toMatchObject({ revisionId: saved.revision.id, actor: anna.actor });
    expect((await beat(ben, TAB_B, 'viewing', saved.revision.id)).newer).toBeNull();
  });

  it('is closed to whoever may not read content', async () => {
    const noRead = as('carol', TENANT, ['media:read']);
    await expect(beat(noRead, TAB_B, 'viewing')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(invoker.run(useCases.listPresence, noRead, { itemId })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('shows nothing of another tenant: its item is a plain not-found', async () => {
    await beat(anna, TAB_A, 'editing');
    const outsider = as('dan', OTHER);
    await expect(beat(outsider, TAB_B, 'viewing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(invoker.run(useCases.listPresence, outsider, { itemId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('leaves no audit row, also when it is refused', async () => {
    await beat(anna, TAB_A, 'editing');
    await beat(as('carol', TENANT, ['media:read']), TAB_B, 'viewing').catch(() => undefined);
    const rows = uow.store.for(TENANT).audit.filter((r) => r.operation.includes('presence'));
    expect(rows).toEqual([]);
  });
});

async function firstBlockEdit(invoker: Invoker, who: Principal, itemId: string, base: string) {
  const { revision } = await invoker.run(useCases.getItem, who, { itemId });
  const block = revision.document.blocks[0];
  if (!block) throw new Error('the example page has no block');
  return { itemId, baseRevisionId: base, blockId: block.id, props: block.props };
}
