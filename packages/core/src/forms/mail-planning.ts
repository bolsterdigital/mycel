// Accepted submissions plan immutable per-recipient events in the same transaction. The existing
// outbox and mail_sends machinery owns delivery; template edits never enumerate old submissions.
import { hashInput } from '../audit/model.js';
import { fieldId, predicateMatches } from './fields.js';
import { emailKey } from '../supporters/email-key.js';
import { UseCaseError } from '../errors.js';
import { entitled, reserveFormMailBudget } from '../entitlements/guards.js';
import type { DomainEvent, TransactionContext } from '../ports.js';
import type { Submission } from './model.js';
import { mailValues, resolveFormMail } from './mail-templates.js';
import type { PinnedMailAction, ResolvedFormMail } from './mail-model.js';

export const FORM_MAIL_SUBSCRIBER = 'forms.mail';
export interface FormMailEventProps {
  submissionId: string;
  // The existing erasure carrier removes the event and intent copies for this address.
  email: string;
  formId: string;
  actionId: string;
  actionVersion: string;
  kind: 'notification' | 'receipt';
  locale: string;
  recipient: string;
  copy: ResolvedFormMail;
}

export async function planFormMail(ctx: TransactionContext, submission: Submission, email: string) {
  const form = submission.evaluation!.definition;
  const { value: settings } = await ctx.formMail.get();
  const config = settings.forms.find((f) => f.formId === form.id && f.enabled);
  const pins: PinnedMailAction[] = [];
  const events: DomainEvent[] = [];
  if (!config) return { pins, events, confirmation: undefined, confirmationVersion: undefined };
  // A campaign's submission is always confirmed (ADR 033 rule 7), with or without consent, and
  // by Mycel even when a provider owns the consent: the link then confirms only the signature.
  const participates = !!submission.evaluation?.campaignId;
  const consented =
    ['signup', 'petition'].includes(form.kind) &&
    form.fields.some((f) => f.type === 'consent' && submission.values[f.name] === true);
  const needsConfirmation = participates || consented;
  // The form's own confirmation copy is written for a subscription. It goes only with the link
  // that confirms one: Mycel-owned, ticked consent. A link that confirms only a signature (no
  // tick, or a provider confirming the consent) keeps the built-in participation copy, so it never
  // asks someone who did not subscribe to confirm a subscription (B2 review R1).
  const confirmation =
    consented &&
    !submission.evaluation?.feedActions?.some((p) => p.feed.confirmationOwner === 'external') &&
    config.confirmation
      ? resolveFormMail(
          settings,
          config.confirmation,
          form,
          submission.locale,
          submission.values,
          'confirmation'
        )
      : undefined;
  const confirmationVersion = confirmation
    ? await hashInput(ctx.inputHasher, {
        domain: 'form-confirmation-v1',
        tenantId: ctx.principal.tenantId,
        formVersion: submission.evaluation!.version,
        ref: config.confirmation,
        effective: resolveFormMail(
          settings,
          config.confirmation!,
          form,
          submission.locale,
          {},
          'confirmation',
          true
        ),
        template: settings.templates.find((t) => t.id === config.confirmation?.templateId) ?? null,
      })
    : undefined;
  const byId = mailValues(form, submission.values);
  for (const action of config.actions) {
    if (!action.enabled || (action.when && !predicateMatches(action.when, byId))) continue;
    // The confirmation itself is the visitor response for a marketing signup. Never add a
    // second visitor-address mail beside it under the same 24-hour admission.
    if (action.kind === 'receipt' && needsConfirmation) continue;
    const copy = resolveFormMail(
      settings,
      action.template,
      form,
      submission.locale,
      submission.values,
      action.kind
    );
    const version = await hashInput(ctx.inputHasher, {
      domain: 'form-mail-action-v1',
      tenantId: ctx.principal.tenantId,
      action,
      effective: resolveFormMail(
        settings,
        action.template,
        form,
        submission.locale,
        {},
        action.kind,
        true
      ),
      template: settings.templates.find((t) => t.id === action.template.templateId) ?? null,
      formVersion: submission.evaluation!.version,
    });
    const recipients = action.kind === 'receipt' ? [email] : action.recipients;
    for (const recipient of recipients) {
      const props: FormMailEventProps = {
        submissionId: submission.id,
        email,
        formId: form.id,
        actionId: action.id,
        actionVersion: version,
        kind: action.kind,
        locale: submission.locale,
        recipient,
        copy,
      };
      const eventId = ctx.ids.next();
      pins.push({ actionId: action.id, version, eventId, recipient });
      events.push({
        id: eventId,
        tenantId: ctx.principal.tenantId,
        type: 'form.mail.planned',
        occurredAt: submission.createdAt,
        actor: ctx.principal.actor,
        props: { ...props },
      });
    }
  }
  // Budget at acceptance, before any new row/event, and in the same transaction. The limiter
  // persists across restarts. Reconciliation of these events does not consume a second quota.
  if (events.length && !entitled(ctx.principal, 'mailing.enabled'))
    throw new UseCaseError('limit_exceeded', 'entitlements.feature-off');
  for (const event of events) {
    const p = event.props as unknown as FormMailEventProps;
    const recipient = await emailKey(ctx.principal.tenantId, p.recipient, 'rate-limit');
    if (
      !(await ctx.rateLimits.hit(`forms.mail:recipient:${recipient}`, {
        max: 20,
        windowSeconds: 3600,
      }))
    )
      throw new UseCaseError('limit_exceeded', 'forms.mail.recipient-limited');
  }
  if (events.length)
    await reserveFormMailBudget(ctx, submission.createdAt.toISOString().slice(0, 7), events.length);
  return { pins, events, confirmation, confirmationVersion };
}

/** Re-evaluate current safety controls, while retaining the accepted action/version/copy. */
export async function formMailAllowed(
  ctx: TransactionContext,
  p: FormMailEventProps,
  eventId: string
) {
  const submission = await ctx.submissions.findById(p.submissionId);
  if (!submission || submission.formId !== p.formId || !submission.evaluation) return false;
  const pin = submission.evaluation.mailActions?.find(
    (a) =>
      a.eventId === eventId &&
      a.actionId === p.actionId &&
      a.version === p.actionVersion &&
      a.recipient === p.recipient
  );
  if (!pin) return false;
  const form = submission.evaluation.definition;
  const emailField = form.fields.find((f) => f.type === 'email');
  if (!emailField || submission.values[emailField.name] !== p.email) return false;
  const { value } = await ctx.formMail.get();
  const config = value.forms.find((f) => f.formId === p.formId && f.enabled);
  const action = config?.actions.find((a) => a.id === p.actionId && a.enabled && a.kind === p.kind);
  if (!action) return false;
  if (p.kind === 'notification') return action.recipients.includes(p.recipient);
  // A receipt is not permission to market; the designated active email is its only destination.
  return (
    p.recipient === p.email && submission.evaluation.activeFieldIds.includes(fieldId(emailField))
  );
}
