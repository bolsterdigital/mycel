// Forms use cases. `form.submit` is the public entry point: anonymous principals carry only
// `forms:write`, so this handler must never reveal anything beyond the outcome of the attempt.

import { z } from 'zod';
import { notFound } from '../errors.js';
import { withinLimit } from '../entitlements/guards.js';
import { defineUseCase } from '../registry.js';
import { sha256Hex } from '../util/digest.js';
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
import { exampleId } from '../util/ids.js';

export const getForm = defineUseCase({
  name: 'form.get',
  kind: 'query',
  description:
    'Get a form definition by id, plus a fresh signed timing token and proof-of-work challenge for rendering it publicly.',
  requires: 'forms:read',
  input: z.object({ id: z.string().guid() }),
  output: z.object({ form: FormDefinition, startedToken: z.string(), proof: ProofChallenge }),
  resource: { uriTemplate: 'mycel://forms/{id}' },
  examples: [{ input: { id: exampleId(0xf000) } }],
  async handler(ctx, { id }) {
    const form = await ctx.forms.findById(id);
    if (!form) throw notFound('form', `the id "${id}"`);
    const now = ctx.clock.now();
    return {
      form,
      startedToken: await issueStartedToken(ctx.signer, id, now),
      proof: await issueProofChallenge(ctx.signer, id, now),
    };
  },
});

const EmailAddress = z.string().trim().toLowerCase().email();
const isChecked = (v: string | boolean | undefined): boolean =>
  v === true || (typeof v === 'string' && v !== '' && v !== 'false');

type FieldErrors = { field: string; message: string }[];

/** Validate raw values against the form's own fields (the definition is data, not a schema). */
export function validateValues(
  fields: readonly FormField[],
  raw: Record<string, string | boolean>
): { values: Record<string, string | boolean>; email: string; errors: FieldErrors } {
  const errors: FieldErrors = [];
  const values: Record<string, string | boolean> = {};
  let email = '';
  for (const field of fields) {
    const value = raw[field.name];
    if (field.type === 'email') {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) {
        if (field.required) errors.push({ field: field.name, message: 'forms.error.required' });
        continue;
      }
      const parsed = EmailAddress.safeParse(text);
      if (!parsed.success) errors.push({ field: field.name, message: 'forms.error.email.invalid' });
      else values[field.name] = email = parsed.data;
    } else {
      const checked = isChecked(value);
      if (!checked) errors.push({ field: field.name, message: 'forms.error.consent.required' });
      values[field.name] = checked;
    }
  }
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

    const { values, email, errors } = validateValues(form.fields, input.values);
    if (errors.length) return { status: 'invalid', errors };

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
    const emailKey = await sha256Hex(`${principal.tenantId}:${email}`);
    if (
      !(await ctx.rateLimits.cooldown(
        `forms.confirm:${form.id}:${emailKey}`,
        CONFIRMATION_COOLDOWN_SECONDS
      ))
    )
      return reject('recipient-limited');

    if (!(await ctx.supporters.getProjection(email)) && !(await ctx.admissions.pending(email))) {
      withinLimit(ctx, 'supporters.max', await ctx.admissions.count());
      await ctx.admissions.reserve(email);
    }

    const submissionId = ctx.ids.next();
    await ctx.submissions.insert({
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
    });

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
      props: { ...props },
    });
    return { status: 'accepted', submissionId };
  },
});
