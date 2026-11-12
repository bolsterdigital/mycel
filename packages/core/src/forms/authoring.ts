// Form authoring is a registry surface, rather than a privileged database write in an admin
// route. Live changes require publishing permission and preserve pinned submission history.
import { z } from 'zod';
import { t } from '../i18n/index.js';
import { defineUseCase } from '../registry.js';
import { can } from '../principal.js';
import { notFound, UseCaseError } from '../errors.js';
import { exampleId } from '../util/ids.js';
import { hashInput } from '../audit/model.js';
import { FormDefinition, parseFormDefinition } from './model.js';
import { validMailPredicate } from './mail-model.js';
import { resolveFormMail } from './mail-templates.js';
import '../campaigns/ports.js';
import { validFeed } from './feed/rules.js';

export const listForms = defineUseCase({
  name: 'form.list',
  kind: 'query',
  requires: 'content:write',
  description: 'List the site form definitions for authoring; no recipient or submission data.',
  input: z.object({}).strict(),
  output: z.object({ forms: z.array(FormDefinition) }),
  examples: [{ input: {} }],
  handler: async (ctx) => ({ forms: await ctx.forms.list() }),
});
export const getFormForAuthoring = defineUseCase({
  name: 'form.authoring.get',
  kind: 'query',
  requires: 'content:write',
  description:
    'Read a form and its save fingerprint for authoring, without a public timing token or challenge.',
  input: z.object({ id: z.string().guid() }).strict(),
  output: z.object({ form: FormDefinition, version: z.string() }),
  examples: [{ input: { id: exampleId(0xf000) } }],
  async handler(ctx, { id }) {
    const form = await ctx.forms.findById(id);
    if (!form) throw notFound('form');
    return {
      form,
      version: await hashInput(ctx.inputHasher, {
        domain: 'form-definition-v1',
        tenantId: ctx.principal.tenantId,
        form,
      }),
    };
  },
});
export const createForm = defineUseCase({
  name: 'form.create',
  kind: 'command',
  requires: 'content:write',
  consumes: null,
  description:
    'Create an unplaced form; signup and petition creation also require publishing permission. Never create send actions.',
  input: z.object({ kind: z.enum(['signup', 'contact', 'petition', 'rsvp']) }).strict(),
  output: FormDefinition,
  examples: [{ input: { kind: 'contact' } }],
  async handler(ctx, { kind }) {
    if (['signup', 'petition'].includes(kind) && !can(ctx.principal, 'content:publish'))
      throw new UseCaseError('forbidden', 'publishing permission required');
    const form = parseFormDefinition({
      id: ctx.ids.next(),
      kind,
      list: 'news',
      consentTextVersion: 'v1',
      submitLabel: Object.fromEntries(['en', 'nl'].map((l) => [l, t(l, 'forms.default.submit')])),
      thankYou: Object.fromEntries(
        ['en', 'nl'].map((l) => [
          l,
          t(
            l,
            kind === 'signup' || kind === 'petition'
              ? 'forms.default.signupThanks'
              : 'forms.default.thankYou'
          ),
        ])
      ),
      fields: [
        {
          id: 'email',
          name: 'email',
          type: 'email',
          required: true,
          label: Object.fromEntries(['en', 'nl'].map((l) => [l, t(l, 'forms.default.email')])),
        },
        ...(kind === 'signup' || kind === 'petition'
          ? [
              {
                id: 'consent',
                name: 'consent',
                type: 'consent',
                // A signature is not mail consent (ADR 033 rule 7): a petition asks, a signup
                // is the subscription itself and needs the tick.
                required: kind === 'signup',
                label: Object.fromEntries(
                  ['en', 'nl'].map((l) => [l, t(l, 'forms.default.consent')])
                ),
              },
            ]
          : []),
      ],
    });
    await ctx.forms.insert(form);
    return form;
  },
});
export const updateForm = defineUseCase({
  name: 'form.update',
  kind: 'command',
  requires: 'content:write',
  description:
    'Save a live form against its fingerprint; refuse broken configured actions and feeds.',
  input: z.object({ baseVersion: z.string().min(1), value: FormDefinition }).strict(),
  output: FormDefinition,
  examples: [
    {
      input: {
        baseVersion: 'v1',
        value: {
          id: exampleId(0xf000),
          kind: 'contact',
          list: 'news',
          consentTextVersion: 'v1',
          minFillSeconds: 3,
          submitLabel: { en: 'Send' },
          thankYou: { en: 'Thanks' },
          fields: [
            { id: 'email', name: 'email', type: 'email', required: true, label: { en: 'Email' } },
          ],
        },
      },
    },
  ],
  async handler(ctx, { baseVersion, value }) {
    const base = await ctx.forms.lock(value.id);
    if (!base) throw notFound('form');
    const version = await hashInput(ctx.inputHasher, {
      domain: 'form-definition-v1',
      tenantId: ctx.principal.tenantId,
      form: base,
    });
    if (version !== baseVersion) throw new UseCaseError('conflict', 'form version changed');
    if (!can(ctx.principal, 'content:publish'))
      throw new UseCaseError('forbidden', 'publishing permission required');
    // ADR 033 rule 3: a campaign's form keeps the kind of its campaign. Read after the form's
    // lock, which binding takes too, so a concurrent bind sees this kind or waits for it.
    if (value.kind !== base.kind && (await ctx.campaigns.byForm(value.id)))
      throw new UseCaseError('conflict', 'campaign.form.kind-locked', [
        { path: 'value.kind', message: 'campaign.form.kind-locked' },
      ]);
    const parsed = parseFormDefinition(value);
    const mail = (await ctx.formMail.get()).value;
    const config = mail.forms.find((f) => f.formId === value.id);
    for (const action of config?.actions ?? []) {
      if (!validMailPredicate(parsed, action))
        throw new UseCaseError('invalid_input', 'invalid mail condition');
      for (const locale of Object.keys(parsed.thankYou))
        resolveFormMail(mail, action.template, parsed, locale, {}, action.kind, true);
    }
    if (config?.confirmation)
      for (const locale of Object.keys(parsed.thankYou))
        resolveFormMail(mail, config.confirmation, parsed, locale, {}, 'confirmation', true);
    if (
      (await ctx.formFeeds.get()).value.feeds.some(
        (f) => f.formId === value.id && !validFeed(parsed, f)
      )
    )
      throw new UseCaseError('invalid_input', 'invalid feed reference');
    if (!(await ctx.forms.save(base, parsed)))
      throw new UseCaseError('conflict', 'form version changed');
    return parsed;
  },
});
export const listFormSubmissions = defineUseCase({
  name: 'form.submission.list',
  kind: 'query',
  requires: 'supporters:read',
  description:
    'List the latest 100 submissions and their pinned definition versions, without visitor values.',
  input: z.object({ formId: z.string().guid() }).strict(),
  output: z.object({
    submissions: z.array(
      z.object({
        id: z.string().guid(),
        createdAt: z.string().datetime(),
        confirmed: z.boolean(),
        version: z.string().nullable(),
      })
    ),
  }),
  examples: [{ input: { formId: exampleId(0xf000) } }],
  async handler(ctx, { formId }) {
    if (!(await ctx.forms.findById(formId))) throw notFound('form');
    return {
      submissions: (await ctx.submissions.list(formId)).map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        confirmed: !!s.confirmedAt,
        version: s.evaluation?.version ?? null,
      })),
    };
  },
});
