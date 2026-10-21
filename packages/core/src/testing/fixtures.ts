// Shared fixtures: the probe tenant, its signup form and page, as data.

import type { PageInput } from '../content/model.js';
import type { FormDefinition } from '../forms/model.js';
import type { TenantInfo } from '../tenants/ports.js';

export function probeForm(id: string): FormDefinition {
  return {
    id,
    kind: 'signup',
    list: 'newsletter',
    fields: [
      {
        type: 'email',
        name: 'email',
        label: { nl: 'E-mailadres', en: 'E-mail address' },
        required: true,
      },
      {
        type: 'consent',
        name: 'consent',
        label: {
          nl: 'Ja, ik wil de nieuwsbrief ontvangen. Afmelden kan altijd.',
          en: 'Yes, send me the newsletter. I can unsubscribe at any time.',
        },
        required: true,
      },
    ],
    submitLabel: { nl: 'Aanmelden', en: 'Sign up' },
    thankYou: {
      nl: 'Bedankt! Check je mailbox en bevestig je inschrijving.',
      en: 'Thank you! Check your inbox and confirm your subscription.',
    },
    consentTextVersion: 'newsletter-2026-10',
    minFillSeconds: 3,
  };
}

export function probePage(formId: string): PageInput {
  return {
    slug: 'signup',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Blijf op de hoogte', en: 'Stay informed' },
    blocks: [
      {
        type: 'heading',
        version: 1,
        props: {
          text: { nl: 'Meld je aan voor de nieuwsbrief', en: 'Sign up for the newsletter' },
        },
      },
      { type: 'signup-form', version: 1, props: { formId } },
    ],
  };
}

export const probeTenant = (id: string): TenantInfo => ({
  id,
  slug: 'probe',
  name: 'Probe',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
});
