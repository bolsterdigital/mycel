// "New petition" in one step (ADR 033 rule 10 and its first example): a new form of the
// matching kind, a draft landing page that places that form, and the campaign in `draft`, in one
// transaction, so a refusal halfway leaves no orphan page or form behind. It runs the three
// existing handlers in order, so every check they make (form kind and publish right, slug and
// reserved slugs, references, the landing rules of `campaign.create`) holds here unchanged.
// Rejected: composing them in the admin route (three transactions; a slug conflict after the form
// was made leaves an unplaced form) and copying their bodies here (two places to keep in step).
// Named `campaign.landing.*` beside `campaign.landing.get`: the campaign addressed through its
// landing page, here made together with it.

import { z } from 'zod';
import { Slug } from '../content/model.js';
import { Locale } from '../i18n/locale.js';
import { createItem } from '../content/service.js';
import { createForm } from '../forms/authoring.js';
import { can } from '../principal.js';
import { UseCaseError } from '../errors.js';
import { defineUseCase } from '../registry.js';
import { CampaignGoal, CampaignView } from './model.js';
import { createCampaign } from './service.js';

/** The kinds that can be made now; a fundraiser waits for the ledger (ADR 005). */
export const ComposableKind = z.enum(['petition', 'signup']);

export const composeCampaign = defineUseCase({
  name: 'campaign.landing.create',
  kind: 'command',
  requires: 'content:write',
  consumes: null,
  description:
    'Start a petition or signup in one step: a new form of that kind, a draft landing page with the title per locale that places the form, and the campaign with participation in draft. Needs form rights and, as for every petition or signup form, publishing permission; nothing is published or opened.',
  input: z
    .object({
      kind: ComposableKind,
      title: z.record(Locale, z.string().trim().min(1).max(300)),
      defaultLocale: Locale,
      locales: z.array(Locale).min(1).max(20),
      slug: Slug.optional(),
      goal: CampaignGoal.nullable().default(null),
      counterVisible: z.boolean().default(true),
    })
    .strict(),
  output: CampaignView,
  examples: [
    {
      input: {
        kind: 'petition',
        title: { nl: 'Red het park', en: 'Save the park' },
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
      },
      note: 'A draft page /red-het-park with a petition form on it; publish the page and open participation separately.',
    },
  ],
  async handler(ctx, { kind, title, defaultLocale, locales, slug, goal, counterVisible }) {
    // Before anything is written: `campaign.create` checks the form right only when it binds.
    if (!can(ctx.principal, 'forms:write'))
      throw new UseCaseError('forbidden', 'form rights required', [
        { path: 'kind', message: 'campaign.forbidden.forms-write' },
      ]);
    const form = await createForm.handler(ctx, createForm.input.parse({ kind }));
    const { item } = await createItem.handler(
      ctx,
      createItem.input.parse({
        ...(slug ? { slug } : {}),
        document: {
          type: 'page',
          title,
          defaultLocale,
          locales,
          blocks: [{ type: 'form', version: 1, props: { formId: form.id } }],
        },
      })
    );
    return createCampaign.handler(
      ctx,
      createCampaign.input.parse({
        kind,
        landingItemId: item.id,
        formId: form.id,
        goal,
        counterVisible,
      })
    );
  },
});
