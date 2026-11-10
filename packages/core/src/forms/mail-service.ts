// Shared authoring, preview and recovery use cases for HTTP, MCP and the later admin editor.
// Rejected: capabilities enforced only by a UI, or a replay operation that resets delivery state.
import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import { can } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { jobKey } from '../jobs/types.js';
import { intentKey } from '../mailing/send-attempts.js';
import { exampleId } from '../util/ids.js';
import { evaluateFields, predicateMatches } from './fields.js';
import { RawValues } from './model.js';
import { Locale } from '../i18n/locale.js';
import {
  FormMailSettings,
  FormMailState,
  ResolvedFormMail,
  validMailPredicate,
} from './mail-model.js';
import { mailValues, resolveFormMail } from './mail-templates.js';
import { FORM_MAIL_SUBSCRIBER } from './mail-planning.js';

export const getFormMailSettings = defineUseCase({
  name: 'form.mail.get',
  kind: 'query',
  requires: 'mailing:read',
  description: 'Read private tenant mail templates and form notification configuration.',
  input: z.object({}).strict(),
  output: FormMailState,
  examples: [{ input: {} }],
  handler: (ctx) => ctx.formMail.get(),
});
export const updateFormMailSettings = defineUseCase({
  name: 'form.mail.update',
  kind: 'command',
  requires: 'mailing:send',
  description:
    'Author mail templates and actions at a known version; activating them also requires content publishing permission.',
  input: z
    .object({ baseVersion: z.number().int().nonnegative(), value: FormMailSettings })
    .strict(),
  output: FormMailState,
  examples: [{ input: { baseVersion: 0, value: { templates: [], forms: [] } } }],
  async handler(ctx, { baseVersion, value }) {
    if (value.forms.some((f) => f.enabled) && !can(ctx.principal, 'content:publish'))
      throw new UseCaseError('forbidden', 'forms.mail.publish.forbidden');
    for (const config of [...value.forms].sort((a, b) => a.formId.localeCompare(b.formId))) {
      const form = await ctx.forms.lock(config.formId);
      if (!form) throw notFound('form');
      for (const action of config.actions) {
        if (!validMailPredicate(form, action))
          throw new UseCaseError('invalid_input', 'forms.mail.condition.invalid');
      }
      // Activation checks every configured language, field reference and resolved value. Local
      // overrides remain intact even when the reusable template is replaced by a later edit.
      const refs = [
        ...config.actions.map((a) => ({ ref: a.template, kind: a.kind })),
        ...(config.confirmation
          ? [{ ref: config.confirmation, kind: 'confirmation' as const }]
          : []),
      ];
      const locales = Object.keys(form.thankYou);
      for (const { ref, kind } of refs)
        for (const locale of locales) resolveFormMail(value, ref, form, locale, {}, kind, true);
    }
    const saved = await ctx.formMail.save(baseVersion, value);
    if (!saved) throw new UseCaseError('conflict', 'forms.mail.version.conflict');
    return saved;
  },
});
export const previewFormMail = defineUseCase({
  name: 'form.mail.test',
  kind: 'query',
  requires: 'mailing:read',
  description:
    'Preview effective action copy and inheritance from validated synthetic values without sending mail.',
  input: z.object({ formId: z.string().guid(), locale: Locale, values: RawValues }).strict(),
  output: z.object({
    confirmation: ResolvedFormMail.nullable(),
    actions: z.array(
      z.object({ actionId: z.string(), matches: z.boolean(), copy: ResolvedFormMail })
    ),
  }),
  examples: [
    {
      input: {
        formId: exampleId(0xf000),
        locale: 'en',
        values: { email: 'a@example.org', consent: true },
      },
    },
  ],
  async handler(ctx, input) {
    const form = await ctx.forms.findById(input.formId);
    if (!form) throw notFound('form');
    const evaluated = evaluateFields(form.fields, input.values);
    if (evaluated.errors.length)
      throw new UseCaseError('invalid_input', 'forms.mail.preview.invalid');
    const { value } = await ctx.formMail.get();
    const config = value.forms.find((f) => f.formId === form.id);
    const byId = mailValues(form, evaluated.values);
    return {
      confirmation: config?.confirmation
        ? resolveFormMail(
            value,
            config.confirmation,
            form,
            input.locale,
            evaluated.values,
            'confirmation'
          )
        : null,
      actions: (config?.actions ?? []).map((a) => ({
        actionId: a.id,
        matches: !!config?.enabled && a.enabled && (!a.when || predicateMatches(a.when, byId)),
        copy: resolveFormMail(value, a.template, form, input.locale, evaluated.values, a.kind),
      })),
    };
  },
});
const SubmissionId = z.object({ submissionId: z.string().guid() }).strict();
export const getFormMailStatus = defineUseCase({
  name: 'form.delivery.get',
  kind: 'query',
  requires: 'mailing:read',
  description: 'Read pinned action versions and delivery attempts for an accepted submission.',
  input: SubmissionId,
  output: z.object({
    actions: z.array(
      z.object({
        actionId: z.string(),
        version: z.string(),
        eventId: z.string().guid(),
        // `expired`: the delivery record passed its retention term (the intent goes with its
        // outbox event after 30 days, the submission lives longer), not work that never began.
        state: z.enum(['pending', 'in_flight', 'unknown', 'sent', 'abandoned', 'expired']),
        attempts: z.number(),
        lastError: z.string().nullable(),
      })
    ),
  }),
  examples: [{ input: { submissionId: exampleId(1) } }],
  async handler(ctx, { submissionId }) {
    const submission = await ctx.submissions.findById(submissionId);
    if (!submission) throw notFound('submission');
    return {
      actions: await Promise.all(
        (submission.evaluation?.mailActions ?? []).map(async (pin) => {
          const row = await ctx.mailSends.get(intentKey(FORM_MAIL_SUBSCRIBER, pin.eventId));
          const state = row?.sentAt
            ? ('sent' as const)
            : row?.abandonedAt
              ? ('abandoned' as const)
              : row?.claimedUntil && row.claimedUntil > ctx.clock.now()
                ? ('in_flight' as const)
                : row?.attemptedAt
                  ? ('unknown' as const)
                  : row || (await ctx.events.exists(pin.eventId))
                    ? ('pending' as const)
                    : ('expired' as const);
          return {
            actionId: pin.actionId,
            version: pin.version,
            eventId: pin.eventId,
            state,
            attempts: row?.attempts ?? 0,
            lastError: row?.lastError ?? null,
          };
        })
      ),
    };
  },
});
export const replayFormMail = defineUseCase({
  name: 'form.mail.replay',
  kind: 'command',
  requires: 'mailing:send',
  effect: 'send',
  description:
    'Schedule reconciliation of an existing pinned action; never reset an unknown or abandoned intent, and schedule nothing once the delivery record passed its retention term.',
  input: z.object({ submissionId: z.string().guid(), eventId: z.string().guid() }).strict(),
  output: z.object({ scheduled: z.boolean() }),
  examples: [{ input: { submissionId: exampleId(1), eventId: exampleId(2) } }],
  async handler(ctx, { submissionId, eventId }) {
    const sub = await ctx.submissions.findById(submissionId);
    if (!sub || !sub.evaluation?.mailActions?.some((a) => a.eventId === eventId))
      throw notFound('form mail action');
    const key = intentKey(FORM_MAIL_SUBSCRIBER, eventId);
    const row = await ctx.mailSends.get(key);
    if (row?.sentAt || row?.abandonedAt) return { scheduled: false };
    // Past its term the event is gone and the job could only fail (`mailReconcileJob` rebuilds
    // the message from it): nothing to reconcile, so no job.
    if (!(await ctx.events.exists(eventId))) return { scheduled: false };
    await ctx.jobs.enqueue({
      type: 'mail.reconcile',
      key: jobKey('mail.reconcile', key),
      runAt: ctx.clock.now(),
      payload: { key, subscriber: FORM_MAIL_SUBSCRIBER, eventId },
    });
    return { scheduled: true };
  },
});
