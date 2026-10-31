// Stuck work of one site, for its administrators (TODO #17c, brief observability-c-recovery
// decisions 2 to 6): what is stuck, the two recoveries for an exhausted job, and the diagnosis to
// share. The hoster does the same platform-wide through the platform API and CLI, with the same
// rules (packages/db/src/infra/recovery.ts). Both recoveries are commands, so the Invoker audits them
// like any other; nobody acts "as" someone else (decision 3).

import { z } from 'zod';
import { toAuditRow, AuditRow } from '../audit/service.js';
import '../audit/ports.js';
import { notFound, UseCaseError } from '../errors.js';
import '../mailing/ports.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import '../tenants/ports.js';
import '../theme/ports.js';
import { ERASURE_UNSECURED_WARN_MS } from '../supporters/erasure.js';
import {
  ErasureBackupView,
  MAIL_DAYS,
  MailDayView,
  OpsVerdict,
  StuckJobView,
  UnresolvedMailView,
  WaitingWorkView,
  buildDiagnosis,
  judgeOps,
  mailDays,
} from './model.js';
import type { RecoveryResult } from './ports.js';
import './ports.js';
import { iso } from '../util/date.js';
import { exampleId } from '../util/ids.js';

/** At most this many exhausted jobs on the page; the platform API pages through the rest. */
const STATUS_JOBS = 100;
const STATUS_AUDIT = 20;
const DIAGNOSIS_FAILED_REQUESTS = 5;

/** The tenant's slug from its platform hostname `<slug>.<domain>` (ADR 014 rule 2). */
async function siteSlug(ctx: TransactionContext): Promise<string> {
  const suffix = `.${ctx.platform.domain}`;
  const platform = (await ctx.hostnames.list()).find((h) => h.kind === 'platform');
  return platform?.hostname.endsWith(suffix)
    ? platform.hostname.slice(0, -suffix.length)
    : ctx.principal.tenantId;
}

export const getOpsStatus = defineUseCase({
  name: 'ops.status.get',
  kind: 'query',
  description:
    "Show how the work of this site is doing: a verdict with the moment it was checked, the waiting work per kind, mail per day in the site's time zone, and what is stuck: jobs that used up their attempts, mail whose delivery is unknown or was given up, erasures no backup holds yet, the latest actions, and a redacted diagnosis to share with support.",
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: z.object({
    verdict: OpsVerdict,
    waiting: z.array(WaitingWorkView),
    jobs: z.array(StuckJobView),
    mails: z.array(UnresolvedMailView),
    /** The last 14 days in the site's time zone, oldest first, zeros included. */
    mailDays: z.array(MailDayView),
    erasures: ErasureBackupView,
    audit: z.array(AuditRow),
    diagnosis: z.string(),
  }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const now = ctx.clock.now();
    const { timeZone: zone } = (await ctx.siteSettings.general()).value;
    // A day longer than the window, so the oldest day is whole in any zone; mailDays trims it.
    const since = new Date(now.getTime() - (MAIL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const [stuck, waiting, unresolved, daily, register, recent, failed, slug] = await Promise.all([
      ctx.jobRecovery.exhausted(STATUS_JOBS),
      ctx.jobRecovery.waiting(),
      ctx.mailSends.unresolved(now),
      ctx.mailSends.daily(since, now, zone),
      ctx.erasures.status(),
      ctx.audit.list({ limit: STATUS_AUDIT }),
      ctx.audit.list({ failed: true, limit: DIAGNOSIS_FAILED_REQUESTS }),
      siteSlug(ctx),
    ]);
    const jobs = stuck.map((j) => ({
      id: j.id,
      type: j.type,
      key: j.key,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
      createdAt: j.createdAt.toISOString(),
    }));
    const mails = unresolved
      // `unresolved` only returns attempted rows; the guard keeps the type honest.
      .filter((m) => m.attemptedAt !== null)
      .map((m) => ({
        state: m.abandonedAt ? ('abandoned' as const) : ('unknown' as const),
        subscriber: m.subscriber,
        attempts: m.attempts,
        attemptedAt: m.attemptedAt!.toISOString(),
        abandonedAt: iso(m.abandonedAt),
        lastError: m.lastError,
      }));
    const oldest = register.oldestUnsecuredAt;
    const erasures = {
      registered: register.registered,
      unsecured: register.registered - register.secured,
      oldestUnsecuredAt: iso(oldest),
      late: oldest !== null && now.getTime() - oldest.getTime() > ERASURE_UNSECURED_WARN_MS,
    };
    return {
      verdict: judgeOps({ jobs, mails, erasures }, now),
      waiting: waiting.map((w) => ({
        type: w.type,
        count: w.count,
        nextRunAt: w.nextRunAt.toISOString(),
      })),
      jobs,
      mails,
      mailDays: mailDays(daily, now, zone),
      erasures,
      audit: recent.map(toAuditRow),
      diagnosis: buildDiagnosis({
        tenantSlug: slug,
        at: now,
        jobs,
        mails,
        erasures,
        failedRequests: failed.flatMap((r) => (r.requestId ? [r.requestId] : [])),
      }),
    };
  },
});

const JobId = z.object({ id: z.string().guid() }).strict();
const Recovered = z.object({ id: z.string().guid() });

function recovered(result: RecoveryResult, id: string): { id: string } {
  if (result === 'not_found') throw notFound('job');
  if (result === 'not_exhausted')
    throw new UseCaseError('conflict', 'the job has attempts left; only an exhausted job recovers');
  return { id };
}

export const retryJob = defineUseCase({
  name: 'ops.job.retry',
  kind: 'command',
  description:
    'Give a job that used up its attempts a new round: its attempts start again from zero and it runs as soon as a worker is free; the last error stays visible until that run. If it fails again it is exhausted again.',
  requires: 'tenant:admin',
  input: JobId,
  output: Recovered,
  examples: [{ input: { id: exampleId(0xb001) } }],
  handler: async (ctx, { id }) => recovered(await ctx.jobRecovery.retry(id), id),
});

export const closeJob = defineUseCase({
  name: 'ops.job.close',
  kind: 'command',
  description:
    'Close a job that used up its attempts without running it again; its last error stays. A recurring or re-verification job is planned anew by its next period or check; a closed mail check leaves the mail unknown and visible on the status page.',
  requires: 'tenant:admin',
  input: JobId,
  output: Recovered,
  examples: [{ input: { id: exampleId(0xb001) } }],
  handler: async (ctx, { id }) => recovered(await ctx.jobRecovery.close(id), id),
});
