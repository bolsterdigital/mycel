// Shared fixtures: the probe tenant, its signup form and page, as data, plus the two steps every
// front's test takes to make that page public: create it, then publish each locale explicitly.
// Also the builders every suite needs (testing.md rule 4): the fixed tenant id of in-memory
// suites, the system principal that administers a tenant, a principal that differs from it only
// in what a case changes, a run suffix for names in a shared
// database, and the check for a typed refusal. Database suites build on these in
// `@mycel/db/testing`.

import type { z } from 'zod';
import type { ContentItem } from '../content/model.js';
import type { FormDefinition } from '../forms/model.js';
import type { ProofChallenge } from '../forms/proof.js';
import type { Invoker } from '../invoke.js';
import type { MediaRepository } from '../media/ports.js';
import type { UnitOfWork } from '../ports.js';
import type { Entitlements } from '../entitlements/model.js';
import type { Principal } from '../principal.js';
import type { TenantInfo } from '../tenants/ports.js';
import { UseCaseError } from '../errors.js';
import { systemPrincipal } from '../principal.js';
import { useCases } from '../use-cases.js';
import { sha256Hex } from '../util/digest.js';

/** The tenant id of every in-memory suite; a database suite creates its own (`testTenant`). */
export const TENANT = '01900000-0000-7000-8000-00000000aaaa';

/** The system principal that administers `tenantId`, as tests act on a tenant. */
export const adminOf = (tenantId: string = TENANT): Principal => systemPrincipal(tenantId, 'test');

/** What a test changes about `adminOf(tenantId)`; `entitlements` are merged over the defaults. */
export type PrincipalChange = Partial<Omit<Principal, 'entitlements'>> & {
  entitlements?: Partial<Entitlements>;
};

/**
 * A principal for one test case: the administrator of `tenantId` (default `TENANT`) with only what
 * the case is about, an actor, capabilities, a limit or a status, so a suite never spells out a
 * whole principal or spreads one by hand.
 */
export function principal({ entitlements, ...change }: PrincipalChange = {}): Principal {
  const base = adminOf(change.tenantId);
  return { ...base, ...change, entitlements: { ...base.entitlements, ...entitlements } };
}

/**
 * Six random characters for names a suite creates in a database shared by runs and branches
 * (slugs, schemas, addresses), so a rerun never meets its own leftovers.
 */
export const runSuffix = (): string => Math.random().toString(36).slice(2, 8);

/**
 * Resolves with the `UseCaseError` `p` rejects with when its code is `code` and, with `message`,
 * one issue message starts with it; throws otherwise. Framework-free, so it ships in this module.
 */
export async function expectCode(
  p: Promise<unknown>,
  code: string,
  message?: string
): Promise<UseCaseError> {
  try {
    await p;
  } catch (e) {
    if (
      e instanceof UseCaseError &&
      e.code === code &&
      (!message || e.issues.some((i) => i.message.startsWith(message)))
    )
      return e;
    throw new Error(
      `expected a ${code} refusal${message ? ` (${message})` : ''}, got ${String(e)}`
    );
  }
  throw new Error(`expected a ${code} refusal, got a result`);
}

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

/**
 * Solves a proof-of-work challenge the way the browser script does (apps/web/static/_form/
 * proof.js) and returns the `_proof` value: base64 of the ALTCHA solution JSON. `number`
 * overrides the search, to post a wrong answer.
 */
export async function solveProof(
  challenge: ProofChallenge,
  overrides: { number?: number; signature?: string } = {}
): Promise<string> {
  let number = overrides.number;
  // In batches, like the script: the digests of one batch run concurrently.
  for (let start = 0; number === undefined && start <= challenge.maxNumber; start += 1000) {
    const batch = Array.from(
      { length: Math.min(1000, challenge.maxNumber - start + 1) },
      (_, i) => start + i
    );
    const hashes = await Promise.all(batch.map((n) => sha256Hex(`${challenge.salt}${n}`)));
    const hit = hashes.indexOf(challenge.challenge);
    if (hit >= 0) number = batch[hit];
  }
  const solution = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: overrides.signature ?? challenge.signature,
  };
  return btoa(JSON.stringify(solution));
}
