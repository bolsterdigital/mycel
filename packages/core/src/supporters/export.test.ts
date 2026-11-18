import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { SupporterEvent } from './events.js';
import { ingest } from './service.js';

const admin = systemPrincipal(TENANT, 'test');
const as = (...capabilities: Principal['capabilities']): Principal => ({
  ...admin,
  capabilities,
});

describe('supporter.export', () => {
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let n = 0;
  const add = (email: string, minute: number, props: Record<string, unknown>) => {
    const id = `export-${n++}`;
    return uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id,
          type: 'newsletter.subscribed',
          email,
          occurred_at: new Date(Date.UTC(2026, 10, 18, 9, minute)).toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: id,
          props,
        })
      )
    );
  };

  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    await add('anna@example.org', 1, { list: 'news' });
    await add('anna@example.org', 2, { list: 'campaign', confirmed: false });
    await add('bram@example.org', 3, { list: 'news' });
    // A visitor typed a formula as their address: the file keeps it as text.
    await add('-2+3@example.org', 4, { list: 'other' });
  });

  it('writes the filtered list as CSV, newest activity first', async () => {
    const all = await invoker.run(useCases.exportSupporters, admin, {});
    const lines = all.csv.split('\r\n');
    expect(lines[0]).toBe('email,lists,pending_lists,first_seen,last_activity,id');
    expect(lines.slice(1, -1).map((l) => l.split(',')[0])).toEqual([
      "'-2+3@example.org",
      'bram@example.org',
      'anna@example.org',
    ]);
    expect(lines.at(-1)).toBe('');
    expect(lines[3]).toContain(',news,campaign,');
    expect(all).toMatchObject({ rows: 3, total: 3, truncated: false });

    const news = await invoker.run(useCases.exportSupporters, admin, {
      list: 'news',
      status: 'confirmed',
    });
    expect(news.rows).toBe(2);
    expect(news.csv).not.toContain('2+3@');
    const one = await invoker.run(useCases.exportSupporters, admin, { q: 'BRAM' });
    expect(one.csv.split('\r\n')[1]).toMatch(/^bram@example\.org,news,,/);
  });

  it('is its own right: reading the list is not enough', async () => {
    await expect(
      invoker.run(useCases.exportSupporters, as('supporters:read'), {})
    ).rejects.toMatchObject({ code: 'forbidden' });
    const allowed = await invoker.run(useCases.exportSupporters, as('supporters:export'), {});
    expect(allowed.rows).toBe(3);
  });
});
