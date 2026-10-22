// Forms use cases. `forms.submit` is the public entry point: anonymous principals carry only
// `forms:write`, so this handler must never reveal anything beyond the outcome of the attempt.

import { z } from 'zod';
import { UseCaseError } from '../errors.js';
import { withinLimit } from '../entitlements/check.js';
import { defineUseCase } from '../registry.js';
import { sha256Hex } from '../util/digest.js';
import type { NewsletterSubscribedProps } from './events.js';
import { FormDefinition, SubmitInput, SubmitResult, type FormField } from './model.js';
import { RATE_LIMITS, checkStartedToken, issueStartedToken } from './spam.js';
import './ports.js';

export const getForm = defineUseCase({
  name: 'forms.form.get',
  kind: 'query',
  description:
    'Get a form definition by id, plus a fresh signed timing token for rendering it publicly.',
  requires: 'forms:read',
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ form: FormDefinition, startedToken: z.string() }),
  resource: { uriTemplate: 'mycel://forms/{id}' },
  examples: [{ input: { id: '01900000-0000-7000-8000-00000000f000' } }],
  async handler(ctx, { id }) {
    const form = await ctx.forms.findById(id);
    if (!form) throw new UseCaseError('not_found', `no form with id "${id}"`);
    return { form, startedToken: await issueStartedToken(ctx.signer, id, ctx.clock.now()) };
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
  name: 'forms.submit',
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
        formId: '01900000-0000-7000-8000-00000000f000',
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
    if (!form) throw new UseCaseError('not_found', `no form with id "${input.formId}"`);

    const reject = (reason: 'spam' | 'too-fast' | 'rate-limited'): SubmitResult => ({
      status: 'rejected',
      reason,
      message: reason === 'spam' ? '' : `forms.rejected.${reason}`,
    });

    // Honeypot and timing apply to the public. Authenticated integrations (API key, agent) are
    // trusted callers and still pass the rate limits below.
    const anonymous = principal.actor.kind === 'anonymous';
    if (anonymous) {
      if (input.spam?.honeypot) return reject('spam');
      const timing = await checkStartedToken(
        ctx.signer,
        input.spam?.startedToken,
        form.id,
        form.minFillSeconds,
        now
      );
      if (timing === 'invalid') return reject('spam');
      if (timing === 'too-fast') return reject('too-fast');
    }

    const ipHash = principal.actor.kind === 'anonymous' ? principal.actor.ipHash : undefined;
    if (ipHash && !(await ctx.rateLimits.hit(`forms.submit:ip:${ipHash}`, RATE_LIMITS.perIp)))
      return reject('rate-limited');

    const { values, email, errors } = validateValues(form.fields, input.values);
    if (errors.length) return { status: 'invalid', errors };

    // Hashed so the counter table holds no address (the submission row is the only copy).
    const emailKey = await sha256Hex(`${principal.tenantId}:${email}`);
    if (!(await ctx.rateLimits.hit(`forms.submit:email:${emailKey}`, RATE_LIMITS.perEmail)))
      return reject('rate-limited');

    // ADR 015: past the spam gate, only a new address grows the supporter count (TODO #16).
    if (!(await ctx.supporters.getProjection(email)))
      withinLimit(ctx, 'supporters.max', await ctx.usage.supporters());

    const submissionId = ctx.ids.next();
    await ctx.submissions.insert({
      id: submissionId,
      formId: form.id,
      values,
      locale: input.locale,
      pageUrl: input.pageUrl ?? null,
      ipHash: ipHash ?? null,
      createdAt: now,
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
