// The arithmetic of the retention terms: calendar months in UTC with the day clamped, the fixed
// outbox term, and the bounds of what a tenant may choose.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { ADMISSION_WINDOW_MS } from '../supporters/ports.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { adminOf, principal, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { DEFAULT_RETENTION, SiteRetention, monthsBefore, retentionCutoffs } from './retention.js';

const at = (iso: string) => new Date(iso);

describe('monthsBefore', () => {
  it('goes back whole calendar months at the same time of day', () => {
    expect(monthsBefore(at('2026-11-10T14:30:15.123Z'), 24)).toEqual(
      at('2024-11-10T14:30:15.123Z')
    );
    expect(monthsBefore(at('2026-01-15T00:00:00.000Z'), 1)).toEqual(at('2025-12-15T00:00:00.000Z'));
    expect(monthsBefore(at('2026-03-10T08:00:00.000Z'), 15)).toEqual(
      at('2024-12-10T08:00:00.000Z')
    );
  });
  it('takes the last day of a month that lacks the day, so a term never runs long', () => {
    expect(monthsBefore(at('2026-03-31T10:00:00.000Z'), 1)).toEqual(at('2026-02-28T10:00:00.000Z'));
    expect(monthsBefore(at('2024-03-31T10:00:00.000Z'), 1)).toEqual(at('2024-02-29T10:00:00.000Z'));
    expect(monthsBefore(at('2026-05-31T10:00:00.000Z'), 1)).toEqual(at('2026-04-30T10:00:00.000Z'));
    // 29 February two years on from a year without one.
    expect(monthsBefore(at('2028-02-29T23:59:59.999Z'), 24)).toEqual(
      at('2026-02-28T23:59:59.999Z')
    );
    expect(monthsBefore(at('2028-02-29T00:00:00.000Z'), 48)).toEqual(
      at('2024-02-29T00:00:00.000Z')
    );
  });
});

describe('retentionCutoffs', () => {
  const now = at('2026-11-10T12:00:00.000Z');
  it('gives the decided terms by default', () => {
    expect(retentionCutoffs(now, DEFAULT_RETENTION)).toEqual({
      outboxBefore: at('2026-10-11T12:00:00.000Z'),
      submissionsBefore: at('2024-11-10T12:00:00.000Z'),
      admissionsThrough: new Date(now.getTime() - ADMISSION_WINDOW_MS),
    });
  });
  it('moves only the submission term with the tenant setting', () => {
    const lower = retentionCutoffs(now, { submissionMonths: 6 });
    expect(lower.submissionsBefore).toEqual(at('2026-05-10T12:00:00.000Z'));
    expect(lower.outboxBefore).toEqual(retentionCutoffs(now, DEFAULT_RETENTION).outboxBefore);
  });
});

describe('site retention setting', () => {
  it('offers one to twenty-four whole months and nothing else', () => {
    for (const submissionMonths of [1, 12, 24])
      expect(SiteRetention.safeParse({ submissionMonths }).success).toBe(true);
    for (const value of [
      { submissionMonths: 0 },
      { submissionMonths: 25 },
      { submissionMonths: 1.5 },
      { submissionMonths: null },
      {},
      { submissionMonths: 12, forever: true },
    ])
      expect(SiteRetention.safeParse(value).success).toBe(false);
  });

  it('reads the default, takes a lower term from an admin at the known version and refuses others', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const admin = adminOf(TENANT);
    expect(await invoker.run(useCases.getSiteRetention, admin, {})).toEqual({
      version: 0,
      value: { submissionMonths: 24 },
    });
    expect(
      await invoker.run(useCases.updateSiteRetention, admin, {
        baseVersion: 0,
        retention: { submissionMonths: 6 },
      })
    ).toEqual({ version: 1, value: { submissionMonths: 6 } });
    await expect(
      invoker.run(useCases.updateSiteRetention, admin, {
        baseVersion: 0,
        retention: { submissionMonths: 3 },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    // An editor who may write forms and content does not decide what is deleted.
    const editor = principal({ capabilities: ['forms:read', 'forms:write', 'content:write'] });
    await expect(
      invoker.run(useCases.updateSiteRetention, editor, {
        baseVersion: 1,
        retention: { submissionMonths: 1 },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await invoker.run(useCases.getSiteRetention, editor, {})).toMatchObject({
      version: 1,
      value: { submissionMonths: 6 },
    });
  });
});
