// Shared fixtures: the probe tenant, its signup form and page, as data, plus the two steps every
// front's test takes to make that page public: create it, then publish each locale explicitly.

import type { z } from 'zod';
import type { ContentItem } from '../content/model.js';
import type { FormDefinition } from '../forms/model.js';
import type { Invoker } from '../invoke.js';
import type { MediaRepository } from '../media/ports.js';
import type { UnitOfWork } from '../ports.js';
import type { Principal } from '../principal.js';
import type { TenantInfo } from '../tenants/ports.js';
import { useCases } from '../use-cases.js';

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

/** `content.item.create` input for the probe's signup page. */
export function probePage(formId: string): z.input<typeof useCases.createItem.input> {
  return {
    slug: 'signup',
    document: {
      type: 'page',
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
    },
  };
}

/** Create the probe page and publish every locale of its first revision. */
export async function publishProbePage(
  invoker: Invoker,
  principal: Principal,
  formId: string,
  input = probePage(formId)
): Promise<ContentItem> {
  const { item, revision } = await invoker.run(useCases.createItem, principal, input);
  let published = item;
  for (const locale of revision.document.locales)
    published = await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale,
    });
  return published;
}

export const probeTenant = (id: string): TenantInfo => ({
  id,
  slug: 'probe',
  name: 'Probe',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
});

/**
 * The same unit of work with some `ctx.media` methods replaced, for tests that need a repository
 * to misbehave (a usage write that records less) or to stop at a point (lock-order races).
 * Works over the memory and the Postgres unit of work alike.
 */
export function overrideMedia(
  uow: UnitOfWork,
  patch: (media: MediaRepository) => Partial<MediaRepository>
): UnitOfWork {
  return {
    run: (principal, fn) =>
      uow.run(principal, (ctx) => fn({ ...ctx, media: { ...ctx.media, ...patch(ctx.media) } })),
  };
}

/**
 * A unit of work that stops the first call of `method` on `ctx.media` until `release()`;
 * `reached` resolves once a transaction is waiting there. With the media lock taken before that
 * point, a second transaction started after `reached` provably runs into the lock.
 */
export function pauseMedia(uow: UnitOfWork, method: Exclude<keyof MediaRepository, 'lock'>) {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const paused = overrideMedia(uow, (media) => ({
    [method]: async (...args: unknown[]) => {
      if (first) {
        first = false;
        markReached();
        await gate;
      }
      return (media[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  }));
  return { uow: paused, reached, release };
}
