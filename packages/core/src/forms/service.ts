// Forms use cases. `form.submit` is the public entry point: anonymous principals carry only
// `forms:write`, so this handler must never reveal anything beyond the outcome of the attempt.

import { z } from 'zod';
import { notFound } from '../errors.js';
import { withinLimit } from '../entitlements/guards.js';
import { defineUseCase } from '../registry.js';
import { emailKey } from '../supporters/email-key.js';
import type { NewsletterSubscribedProps } from './events.js';
import { FormDefinition, SubmitInput, SubmitResult, type FormField } from './model.js';
import { ProofChallenge, checkProof, issueProofChallenge } from './proof.js';
import {
  CONFIRMATION_COOLDOWN_SECONDS,
  RATE_LIMITS,
  checkStartedToken,
  issueStartedToken,
} from './spam.js';
import './ports.js';
import { planFormMail } from './mail-planning.js';
import { evaluateFields } from './fields.js';
import { hashInput } from '../audit/model.js';
import { exampleId } from '../util/ids.js';

export const getForm = defineUseCase({
  name: 'form.get',
  kind: 'query',
  description:
    'Get a form definition by id, plus a fresh signed timing token and proof-of-work challenge for rendering it publicly.',
  requires: 'forms:read',
  input: z.object({ id: z.string().guid() }),
  output: z.object({
    form: FormDefinition,
    startedToken: z.string(),
    proof: ProofChallenge,
    version: z.string(),
  }),
  resource: { uriTemplate: 'mycel://forms/{id}' },
  examples: [{ input: { id: exampleId(0xf000) } }],
  async handler(ctx, { id }) {
    const form = await ctx.forms.findById(id);
    if (!form) throw notFound('form', `the id "${id}"`);
    const now = ctx.clock.now();
    return {
      form,
      version: await hashInput(ctx.inputHasher, {
        domain: 'form-definition-v1',
        tenantId: ctx.principal.tenantId,
        form,
      }),
      startedToken: await issueStartedToken(ctx.signer, id, now),
      proof: await issueProofChallenge(ctx.signer, id, now),
    };
  },
});

/** Legacy validation entry point; the submission path also retains evaluation decisions. */
export function validateValues(
  fields: readonly FormField[],
  raw: Parameters<typeof evaluateFields>[1]
) {
  const { values, email, errors } = evaluateFields(fields, raw);
  return { values, email, errors };
}

export const submitForm = defineUseCase({
  name: 'form.submit',
  kind: 'command',
  description:
    'Submit a signup form. Stores the submission and publishes newsletter.subscribed; returns accepted, invalid (field errors as i18n keys) or rejected (spam defence).',
  requires: 'forms:write',
  consumes: 'supporters.max',
  input: SubmitInput,
  output: SubmitResult,
  examples: [
    {
      input: {
        formId: exampleId(0xf000),
        values: { email: 'a@example.org', consent: true },
        locale: 'nl',
      },
      note: 'An authenticated integration; anonymous callers also send `spam.startedToken`.',
    },
  ],
  async handler(ctx, input): Promise<SubmitResult> {
    const { principal, clock } = ctx;
    const now = clock.now();
    const form = await ctx.forms.findById(input.formId);
    if (!form) throw notFound('form', `the id "${input.formId}"`);

    // One log line per refusal with a fixed reason, never the address, IP hash or token (house
    // rule 7: fail visibly for us, silently for the bot); tenant and request id come from the
    // log context. The public `reason` is coarser: honeypot and a bad token are both `spam`.
    const reject = (
      why:
        | 'honeypot'
        | 'token-invalid'
        | 'too-fast'
        | 'proof-invalid'
        | 'ip-limited'
        | 'recipient-limited'
    ): SubmitResult => {
      ctx.log.info('form.submit.rejected', { formId: form.id, reason: why });
      const reason =
        why === 'honeypot' || why === 'token-invalid' || why === 'proof-invalid'
          ? 'spam'
          : why === 'ip-limited'
            ? 'rate-limited'
            : why;
      return {
        status: 'rejected',
        reason,
        message:
          reason === 'too-fast' || reason === 'rate-limited' ? `forms.rejected.${reason}` : '',
      };
    };

    // Honeypot, timing and proof apply to the public. Authenticated integrations (API key, agent)
    // are trusted callers and still pass the rate limits below. A post without the honeypot
    // field is not from our form (checklist rule 8 of `formulieren-en-mail`); a post without a
    // proof is, from a browser without JavaScript, and takes the stricter bucket below.
    const anonymous = principal.actor.kind === 'anonymous';
    let unproven = false;
    if (anonymous) {
      if (input.spam?.honeypot === undefined || input.spam.honeypot !== '')
        return reject('honeypot');
      const timing = await checkStartedToken(
        ctx.signer,
        input.spam.startedToken,
        form.id,
        form.minFillSeconds,
        now
      );
      if (timing === 'invalid') return reject('token-invalid');
      if (timing === 'too-fast') return reject('too-fast');
      const proof = await checkProof(ctx.signer, input.spam.proof, form.id, now);
      if (proof.kind === 'invalid') return reject('proof-invalid');
      // One use per solution, for as long as the challenge lives. The cooldown is the same
      // primitive as the recipient's, so two posts of one solution at once count as two.
      if (
        proof.kind === 'ok' &&
        !(await ctx.rateLimits.cooldown(`forms.proof:${proof.challenge}`, 24 * 3600))
      )
        return reject('proof-invalid');
      unproven = proof.kind === 'absent';
    }

    const ipHash = principal.actor.kind === 'anonymous' ? principal.actor.ipHash : undefined;
    if (ipHash && !(await ctx.rateLimits.hit(`form.submit:ip:${ipHash}`, RATE_LIMITS.perIp)))
      return reject('ip-limited');
    if (unproven) {
      ctx.log.info('form.submit.unproven', { formId: form.id });
      if (
        ipHash &&
        !(await ctx.rateLimits.hit(`form.submit:unproven:${ipHash}`, RATE_LIMITS.perIpUnproven))
      )
        return reject('ip-limited');
    }

    const version = await hashInput(ctx.inputHasher, {
      domain: 'form-definition-v1',
      tenantId: principal.tenantId,
      form,
    });
    if (input.formVersion && input.formVersion !== version)
      return {
        status: 'invalid',
        errors: [{ field: form.fields[0]!.name, message: 'forms.error.version' }],
      };
    const evaluated = evaluateFields(form.fields, input.values);
    const { values, email, errors, consent, activeFieldIds, requiredFieldIds, discardedFieldIds } =
      evaluated;
    if (errors.length) return { status: 'invalid', errors };

    const submissionId = ctx.ids.next();
    const submission: import('./model.js').Submission = {
      id: submissionId,
      formId: form.id,
      values,
      locale: input.locale,
      pageUrl: input.pageUrl ?? null,
      ipHash: ipHash ?? null,
      createdAt: now,
      list: form.list,
      consentTextVersion: form.consentTextVersion,
      confirmedAt: null,
      evaluation: {
        version,
        definition: form,
        activeFieldIds,
        requiredFieldIds,
        discardedFieldIds,
      },
    };
    // ADR 015 rule 3: only a new address grows the supporter count. The projection exists only
    // after the outbox ingest, so the seat is reserved here and released by ingest
    // (`ctx.admissions`, TODO #16). The lock comes first and ingest takes the same lock before
    // it releases, so a projection cannot land between this check and the reservation and leave
    // a seat taken for the whole admission window.
    await ctx.admissions.lock();

    // Every signup causes a confirmation mail, so every signup passes the recipient cooldown.
    // After the tenant lock, which already serialises submissions; the adapter's own lock makes
    // the primitive safe without it. Hashed so the table holds no address (the submission row is
    // the only copy). A refusal writes nothing: no submission, no event, no seat.
    const recipientKey = await emailKey(principal.tenantId, email, 'rate-limit');
    if (
      !(await ctx.rateLimits.cooldown(
        `forms.confirm:${form.id}:${recipientKey}`,
        CONFIRMATION_COOLDOWN_SECONDS
      ))
    )
      return reject('recipient-limited');

    const mailPlan = await planFormMail(ctx, submission, email);
    submission.evaluation!.mailActions = mailPlan.pins;
    if (mailPlan.confirmation && mailPlan.confirmationVersion)
      submission.evaluation!.confirmationMail = {
        version: mailPlan.confirmationVersion,
        copy: mailPlan.confirmation,
      };
    for (const event of mailPlan.events) await ctx.events.publish(event);

    // A receipt is not marketing permission. Inactive or unchecked consent creates no signup,
    // no admission seat and no confirmation mail, even if a browser forged its checkbox value.
    if (!consent || !['signup', 'petition'].includes(form.kind)) {
      await ctx.submissions.insert(submission);
      return { status: 'accepted', submissionId };
    }

    if (!(await ctx.supporters.getProjection(email)) && !(await ctx.admissions.pending(email))) {
      withinLimit(ctx, 'supporters.max', await ctx.admissions.count());
      await ctx.admissions.reserve(email);
    }

    await ctx.submissions.insert(submission);

    const props: NewsletterSubscribedProps = {
      email,
      list: form.list,
      formId: form.id,
      submissionId,
      locale: input.locale,
      pageUrl: input.pageUrl ?? null,
      consentTextVersion: form.consentTextVersion,
      confirmed: false,
    };
    await ctx.events.publish({
      id: ctx.ids.next(),
      type: 'newsletter.subscribed',
      tenantId: principal.tenantId,
      occurredAt: now,
      actor: principal.actor,
      props: {
        ...props,
        formVersion: version,
        ...(mailPlan.confirmation
          ? {
              confirmationCopy: mailPlan.confirmation,
              confirmationVersion: mailPlan.confirmationVersion,
            }
          : {}),
      },
    });
    return { status: 'accepted', submissionId };
  },
});
