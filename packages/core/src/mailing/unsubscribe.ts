// Unsubscribe with one click (ADR 010 rule 8, RFC 8058). Every bulk message carries a link signed
// for one recipient and one list. The token names the supporter by its stable id (ADR 019 rule
// 1), never by address: a leaked link discloses nothing, and an address change on the supporter
// leaves the link working for the person it was sent to.
//
// Two front doors, one command. The link in the mail opens a page that only reads
// (`mailing.opt_out.get`) and posts `mailing.opt_out.confirm` from its button, so a link scanner
// that fetches the page records nothing, like the double opt-in. The `List-Unsubscribe` header
// points at a sibling address that a mail provider POSTs to with `List-Unsubscribe=One-Click`;
// its GET leads to the same page. Rejected: unsubscribing on the GET of the link (a scanner then
// unsubscribes the person), and the provider's POST on the page route itself, whose CSRF check
// would have to be lifted for the person's own button too (apps/web, csrf.ts).
//
// The withdrawal is appended to the supporter's log and folded in the same transaction, through
// `ingest`: the next send reads a projection without the list. Idempotent through the projection:
// a second click finds the list gone and answers `already_unsubscribed` without a second event.
// Rejected: publishing a domain event for the supporter subscriber to ingest after commit (the
// outbox is then the only thing between a click and the next send), and a table of withdrawals
// next to the log that already holds them.

import { z } from 'zod';
import type { Clock, Signer, TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { isTombstone } from '../supporters/erasure.js';
import { ingest, SOURCE } from '../supporters/service.js';
import { SupporterEvent } from '../supporters/events.js';
import type { PlatformConfig } from '../tenants/ports.js';
import { siteUrl } from '../tenants/url.js';
import { sha1Hex } from '../util/digest.js';
import './ports.js';

/**
 * A year: a newsletter read again months later must still unsubscribe (RFC 8058 asks for no
 * expiry; CAN-SPAM for at least 30 days). The token can only remove a permission, so a long life
 * gives an attacker nothing. Rejected: no expiry at all, which leaves no way to retire old links
 * short of rotating the signing secret.
 */
export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The site-relative path of the page and of the one-click address. */
export const UNSUBSCRIBE_PATH = '/unsubscribe';
export const ONE_CLICK_PATH = '/unsubscribe/one-click';

/** The value RFC 8058 puts in `List-Unsubscribe-Post` and in the body of the provider's POST. */
export const ONE_CLICK_VALUE = 'List-Unsubscribe=One-Click';

/**
 * `kind` keeps tokens of one purpose from passing as another: every token of this application is
 * signed with one key, and a confirm or sign-in payload must never read as an unsubscribe.
 */
interface UnsubscribePayload {
  kind: 'unsubscribe';
  tenantId: string;
  supporterId: string;
  list: string;
  /** The language of the mail, so the page answers in it; never the address. */
  locale?: string;
  exp: number;
}

export type UnsubscribeFields = Omit<UnsubscribePayload, 'kind' | 'exp'>;

export function signUnsubscribeToken(
  signer: Signer,
  fields: UnsubscribeFields,
  now: Date
): Promise<string> {
  const payload: UnsubscribePayload = {
    kind: 'unsubscribe',
    ...fields,
    exp: now.getTime() + UNSUBSCRIBE_TTL_MS,
  };
  return signer.sign(JSON.stringify(payload));
}

export async function verifyUnsubscribeToken(
  signer: Signer,
  token: string,
  now: Date
): Promise<UnsubscribePayload | null> {
  const raw = await signer.verify(token);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<UnsubscribePayload>;
    if (
      p.kind !== 'unsubscribe' ||
      typeof p.tenantId !== 'string' ||
      typeof p.supporterId !== 'string' ||
      typeof p.list !== 'string' ||
      (p.locale !== undefined && typeof p.locale !== 'string') ||
      typeof p.exp !== 'number' ||
      p.exp < now.getTime()
    )
      return null;
    return p as UnsubscribePayload;
  } catch {
    return null;
  }
}

export interface UnsubscribeLinkDeps {
  signer: Signer;
  clock: Clock;
  platform: Pick<PlatformConfig, 'platformOrigin' | 'siteUrlMode'>;
}

export interface UnsubscribeLink {
  /** The page with one button: for the footer of the mail. */
  url: string;
  /** Where a provider POSTs `List-Unsubscribe=One-Click`; a GET leads to `url`. */
  oneClickUrl: string;
  /** `List-Unsubscribe` and `List-Unsubscribe-Post` for `MailMessage.headers` (RFC 8058). */
  headers: Record<string, string>;
}

/**
 * The unsubscribe link and headers of one recipient of one list, for every bulk message (ADR 010
 * rule 8): the bulk send calls it per recipient). The caller reads the primary hostname once per send,
 * under the tenant's RLS; the link is on it, like every link in a mail (ADR 014 rule 6).
 */
export async function unsubscribeLink(
  deps: UnsubscribeLinkDeps,
  input: {
    tenant: { id: string; slug: string };
    primaryHostname: string | null;
    supporterId: string;
    list: string;
    locale?: string;
  }
): Promise<UnsubscribeLink> {
  const token = await signUnsubscribeToken(
    deps.signer,
    {
      tenantId: input.tenant.id,
      supporterId: input.supporterId,
      list: input.list,
      ...(input.locale ? { locale: input.locale } : {}),
    },
    deps.clock.now()
  );
  const site = { slug: input.tenant.slug, primaryHostname: input.primaryHostname };
  const query = `?token=${encodeURIComponent(token)}`;
  const url = siteUrl(site, deps.platform, `${UNSUBSCRIBE_PATH}${query}`);
  const oneClickUrl = siteUrl(site, deps.platform, `${ONE_CLICK_PATH}${query}`);
  return {
    url,
    oneClickUrl,
    headers: { 'List-Unsubscribe': `<${oneClickUrl}>`, 'List-Unsubscribe-Post': ONE_CLICK_VALUE },
  };
}

const OptOutInput = z.object({ token: z.string().min(1) });

export const OptOutPreview = z.object({
  /** `invalid` covers a forged, expired or foreign token and an erased or vanished supporter. */
  status: z.enum(['subscribed', 'already_unsubscribed', 'invalid']),
  /** The language of the mail the link came in; absent when the token is invalid. */
  locale: z.string().optional(),
});
export type OptOutPreview = z.infer<typeof OptOutPreview>;

export const OptOutResult = z.object({
  status: z.enum(['unsubscribed', 'already_unsubscribed', 'invalid']),
  locale: z.string().optional(),
});
export type OptOutResult = z.infer<typeof OptOutResult>;

/**
 * The supporter a token names, with its current address, or null when the token is worth
 * nothing: forged, expired, for another tenant (ADR 002 rule 3: the tenant is the site visited,
 * never the token's), for a supporter that is gone or erased. Locks the address, so a click and
 * an ingest of the same supporter serialise (ADR 019 rule 3).
 */
async function resolveToken(ctx: TransactionContext, token: string, now: Date) {
  const payload = await verifyUnsubscribeToken(ctx.signer, token, now);
  if (!payload || payload.tenantId !== ctx.principal.tenantId) return null;
  const before = await ctx.supporters.getProjectionById(payload.supporterId);
  if (!before || isTombstone(before.email)) return null;
  await ctx.supporters.lock(before.email);
  // Reread under the lock: an address change in between would leave the lock on the old one.
  const supporter = await ctx.supporters.getProjectionById(payload.supporterId);
  if (!supporter || supporter.email !== before.email) return null;
  if (!(await ctx.erasures.allows(supporter.email, supporter.id))) return null;
  // The address must still resolve to this supporter, because `ingest` resolves by address.
  if ((await ctx.supporters.getProjection(supporter.email))?.id !== supporter.id) return null;
  const subscribed =
    supporter.lists.includes(payload.list) || supporter.pendingLists.includes(payload.list);
  return { supporter, list: payload.list, locale: payload.locale, subscribed };
}

export const previewOptOut = defineUseCase({
  name: 'mailing.opt_out.get',
  kind: 'query',
  description:
    'Read what an unsubscribe link would do, without doing it: subscribed, already unsubscribed or invalid, with the language of the mail.',
  // The capability of the command, like `mailing.opt_in.get`: the page reads what its button
  // would do, so one principal serves both steps.
  requires: 'supporters:write',
  input: OptOutInput,
  output: OptOutPreview,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'A forged, expired or foreign token gives status "invalid"; nothing is written for any status.',
    },
  ],
  async handler(ctx, { token }): Promise<OptOutPreview> {
    const found = await resolveToken(ctx, token, ctx.clock.now());
    if (!found) return { status: 'invalid' };
    const locale = found.locale ? { locale: found.locale } : {};
    return { status: found.subscribed ? 'subscribed' : 'already_unsubscribed', ...locale };
  },
});

export const confirmOptOut = defineUseCase({
  name: 'mailing.opt_out.confirm',
  kind: 'command',
  description:
    'Unsubscribe the supporter of a signed link from its list: appends newsletter.unsubscribed to the supporter log and removes the list from the projection at once; a second click or an invalid token is an outcome, not an error.',
  requires: 'supporters:write',
  input: OptOutInput.extend({
    /** How the request came: the page's button or a provider's RFC 8058 POST. Evidence only. */
    via: z.enum(['page', 'one_click']).default('page'),
  }),
  output: OptOutResult,
  examples: [
    {
      input: { token: 'not-a-signed-token' },
      note: 'A forged, expired or foreign token gives status "invalid"; the page shows a plain message.',
    },
  ],
  async handler(ctx, { token, via }): Promise<OptOutResult> {
    const now = ctx.clock.now();
    const found = await resolveToken(ctx, token, now);
    if (!found) return { status: 'invalid' };
    const { supporter, list } = found;
    const locale = found.locale ? { locale: found.locale } : {};
    if (!found.subscribed) return { status: 'already_unsubscribed', ...locale };
    const occurredAt = now.toISOString();
    const sourceRef = `unsubscribe:${supporter.id}:${list}`;
    const type = 'newsletter.unsubscribed';
    await ingest(
      ctx,
      SupporterEvent.parse({
        schema: 'wings.supporter-event.v1',
        id: await sha1Hex([SOURCE, sourceRef, type, occurredAt].join('|')),
        type,
        email: supporter.email,
        occurred_at: occurredAt,
        source: SOURCE,
        source_site: 'urn:mycel:mailing:unsubscribe',
        source_ref: sourceRef,
        props: { list, via },
      })
    );
    return { status: 'unsubscribed', ...locale };
  },
});
