// The launch checklist use cases (MY-262, ADR 037). One read gathers the site's facts through the
// ports the owning screens already use (hostnames, connections, statistics, forms, members, the
// home page and the status page's counts), evaluates the checks and folds in what people stored.
// The facts are read through ports, not the other modules' use cases, so `tenant:admin` alone
// opens the list (rule 7) and the read costs a fixed number of queries whatever the site holds.
// Rejected: storing check outcomes (they would be stale the moment a domain verifies), and a
// launch gate on publishing or domains (rule 6: the list advises, it never blocks).

import { z } from 'zod';
import { sameSite } from '../analytics/service.js';
import '../analytics/ports.js';
import '../connections/ports.js';
import '../content/ports.js';
import { statusOf } from '../content/lifecycle.js';
import { entitled } from '../entitlements/guards.js';
import type { FeatureName } from '../entitlements/model.js';
import { UseCaseError } from '../errors.js';
import '../forms/ports.js';
import '../mailing/ports.js';
import '../ops/ports.js';
import { roleFor } from '../operators/roles.js';
import '../operators/ports.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { ERASURE_UNSECURED_WARN_MS } from '../supporters/erasure.js';
import '../tenants/ports.js';
import { LAUNCH_CHECKS, type LaunchFacts } from './evaluate.js';
import {
  LaunchChecklist,
  LaunchStepPatch,
  type ApplicableSource,
  type LaunchPhaseView,
  type LaunchStepView,
} from './model.js';
import type { LaunchStepRecord } from './ports.js';
import './ports.js';
import {
  LAUNCH_STEPS,
  LaunchPhase,
  launchStep,
  type LaunchGroup,
  type LaunchStepDefinition,
} from './steps.js';

/** As many exhausted jobs as the status page reads; the check only needs to know there are any. */
const OPS_JOBS = 100;

/** The entitlement a group of steps depends on (ADR 037 rule 4). */
const GROUP_FEATURE: Readonly<Record<LaunchGroup, FeatureName>> = {
  giving: 'donations.enabled',
  mailing: 'mailing.enabled',
  domain: 'custom_domain',
};

async function facts(ctx: TransactionContext): Promise<LaunchFacts> {
  const now = ctx.clock.now();
  const [home, members, forms, formMail, connections, analytics, hostnames, jobs, mails, erasures] =
    await Promise.all([
      ctx.content.findBySlug('page', 'index'),
      ctx.members.list(),
      ctx.forms.list(),
      ctx.formMail.get(),
      ctx.connections.list(),
      ctx.analyticsSettings.get(),
      ctx.hostnames.list(),
      ctx.jobRecovery.exhausted(OPS_JOBS),
      ctx.mailSends.unresolved(now),
      ctx.erasures.status(),
    ]);
  const mailOf = new Map(formMail.value.forms.map((f) => [f.formId, f]));
  const mollie = connections.find((c) => c.provider === 'mollie' && c.state !== 'disconnected');
  const primary = hostnames.find((h) => h.primary);
  const domain = analytics.value.plausibleDomain;
  const late =
    erasures.oldestUnsecuredAt !== null &&
    now.getTime() - erasures.oldestUnsecuredAt.getTime() > ERASURE_UNSECURED_WARN_MS;
  return {
    home: {
      locales: home ? home.publication.map((s) => s.locale) : [],
      published: home
        ? home.publication.filter((s) => statusOf(s) === 'published').map((s) => s.locale)
        : [],
    },
    members: members.map((m) => ({ role: roleFor(m.capabilities), pending: m.pending })),
    forms: forms.map((f) => {
      const mail = mailOf.get(f.id);
      return {
        id: f.id,
        label: f.name ? (Object.values(f.name)[0] ?? null) : null,
        notifies:
          !!mail?.enabled &&
          mail.actions.some(
            (a) => a.kind === 'notification' && a.enabled && a.recipients.length > 0
          ),
      };
    }),
    mollie: mollie ? { connected: mollie.state === 'active' && mollie.hasCredential } : null,
    analytics: {
      domain,
      hostnameMismatch: domain !== null && !!primary && !sameSite(domain, primary.hostname),
    },
    hostnames: hostnames.map((h) => ({
      hostname: h.hostname,
      kind: h.kind,
      primary: h.primary,
      verified: h.verifiedAt !== null,
    })),
    ops: {
      jobs: jobs.length,
      mails: mails.filter((m) => m.abandonedAt !== null).length,
      erasures: late ? erasures.registered - erasures.secured : 0,
    },
  };
}

function applicability(
  ctx: TransactionContext,
  step: LaunchStepDefinition,
  stored: LaunchStepRecord | undefined
): { applicable: boolean; source: ApplicableSource } {
  if (stored?.applicable != null) return { applicable: stored.applicable, source: 'override' };
  if (step.group && !entitled(ctx.principal, GROUP_FEATURE[step.group]))
    return { applicable: false, source: 'entitlement' };
  return { applicable: true, source: 'default' };
}

function view(
  ctx: TransactionContext,
  step: LaunchStepDefinition,
  stored: LaunchStepRecord | undefined,
  known: LaunchFacts
): LaunchStepView {
  const { applicable, source } = applicability(ctx, step, stored);
  const done = stored?.done ?? false;
  const acknowledged = stored?.acknowledged ?? false;
  const outcome = step.check ? LAUNCH_CHECKS[step.check](known) : null;
  const status = !applicable ? 'na' : outcome ? outcome.result : done ? 'done' : 'open';
  const complete =
    applicable &&
    (outcome ? outcome.result === 'pass' || (outcome.result === 'warn' && acknowledged) : done);
  return {
    id: step.id,
    phase: step.phase,
    kind: step.check ? 'check' : 'manual',
    check: step.check ?? null,
    group: step.group ?? null,
    owner: stored?.owner ?? step.owner,
    ownerOverridden: stored?.owner != null,
    applicable,
    applicableSource: source,
    status,
    complete,
    done,
    acknowledged,
    detail: outcome?.detail ?? null,
    note: stored?.note ?? '',
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
  };
}

async function checklist(ctx: TransactionContext): Promise<LaunchChecklist> {
  const [stored, known] = await Promise.all([ctx.launchSteps.list(), facts(ctx)]);
  const byId = new Map(stored.map((r) => [r.stepId, r]));
  const steps = LAUNCH_STEPS.map((s) => view(ctx, s, byId.get(s.id), known));
  const phases: LaunchPhaseView[] = LaunchPhase.options.map((phase) => {
    const own = steps.filter((s) => s.phase === phase);
    const counted = own.filter((s) => s.applicable);
    return {
      phase,
      total: counted.length,
      complete: counted.filter((s) => s.complete).length,
      steps: own,
    };
  });
  const blocking = steps
    .filter((s) => s.phase !== 'after' && s.applicable && !s.complete)
    .map((s) => s.id);
  return {
    phases,
    ready: blocking.length === 0,
    blocking,
    checkedAt: ctx.clock.now().toISOString(),
  };
}

export const getLaunchChecklist = defineUseCase({
  name: 'launch.checklist.get',
  kind: 'query',
  description:
    "Read this site's launch checklist: every step before, on and after the launch day, who owns it, whether it is done or what Mycel found when it checked, and whether the site is ready to go live.",
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: LaunchChecklist,
  examples: [{ input: {} }],
  handler: (ctx) => checklist(ctx),
});

export const updateLaunchStep = defineUseCase({
  name: 'launch.step.update',
  kind: 'command',
  description:
    'Change one step of the launch checklist: tick it, accept a warning, write a note, give it another owner, or switch it off or on for this site. Returns the whole checklist.',
  requires: 'tenant:admin',
  input: LaunchStepPatch,
  output: LaunchChecklist,
  examples: [{ input: { stepId: 'go-no-go', done: true, note: 'Approved by the board.' } }],
  async handler(ctx, patch) {
    if (!launchStep(patch.stepId))
      throw new UseCaseError('invalid_input', 'unknown launch step', [
        { path: 'stepId', message: 'launch.step.unknown', params: { id: patch.stepId } },
      ]);
    const current = (await ctx.launchSteps.list()).find((r) => r.stepId === patch.stepId);
    await ctx.launchSteps.put({
      stepId: patch.stepId,
      done: patch.done ?? current?.done ?? false,
      acknowledged: patch.acknowledged ?? current?.acknowledged ?? false,
      note: patch.note ?? current?.note ?? '',
      owner: patch.owner !== undefined ? patch.owner : (current?.owner ?? null),
      applicable: patch.applicable !== undefined ? patch.applicable : (current?.applicable ?? null),
      updatedAt: ctx.clock.now(),
    });
    return checklist(ctx);
  },
});
