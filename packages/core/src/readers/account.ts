// Reader self-service (ADR 016 rule 1, ADR 019 rule 7): what a signed-in reader may see and change
// of themselves on the site they read. The supporter is the one the session row names, read with
// its live projection on every call; no input names a supporter, a tenant or an address, so a
// reader of site A can only ever reach their own supporter of site A.
//
// `reader.account.get` shows the address the session proved, the standing and expired grants with
// their tier names, the newsletter lists, the last sign-in and how long the site keeps sign-ins.
// `reader.subscription.withdraw` ends one list the reader is on, through the same withdrawal as
// the unsubscribe link in a mail. Nothing here changes a membership: until the ledger offers
// change, pause and cancel (ADR 005), the page shows the status and no button that pretends to.
//
// Both run as the `reader` actor only, with the reader's `content:read`. Rejected: a new
// capability for self-service (the actor already narrows it to one person, the session's own,
// and an API key or an agent can never be that actor), and the supporter id in the input (a
// cookie would then pick whose data to read).

import { z } from 'zod';
import { notFound, type UseCaseError } from '../errors.js';
import { localized } from '../i18n/locale.js';
import { lockedLiveSupporter, onList, withdrawFromList } from '../mailing/unsubscribe.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { AccessTierKind, grantStands } from '../content/access/model.js';
import { AccessGrantKind, type SupporterProjection } from '../supporters/model.js';
import '../content/ports.js';
import '../supporters/ports.js';
import { liveSession } from './service.js';
import type { ReaderSession } from './model.js';
import './ports.js';

const Timestamp = z.string().datetime({ offset: true });

export const ReaderAccessEntry = z.object({
  tierId: z.string().guid(),
  /** The tier's name per locale, as the site publishes it. */
  name: localized(z.string()),
  kind: AccessTierKind,
  grantKind: AccessGrantKind,
  /** Exclusive end; null is open-ended. */
  until: Timestamp.nullable(),
  /** Whether the grant opens its tier now; an expired one is still listed, as expired. */
  standing: z.boolean(),
});

export const ReaderAccount = z.object({
  /** The address this session proved: the reader's own, never in a URL or a log line. */
  email: z.string().email(),
  /** The last sign-in, kept after retention removed the sign-in events. */
  lastSeenAt: Timestamp.nullable(),
  sessionExpiresAt: Timestamp,
  access: z.array(ReaderAccessEntry),
  lists: z.array(z.object({ list: z.string(), status: z.enum(['confirmed', 'pending']) })),
  /** How many days this site keeps sign-in events; 0 keeps only `lastSeenAt`. */
  activityRetentionDays: z.number().int().min(0),
});
export type ReaderAccount = z.infer<typeof ReaderAccount>;

/**
 * The standing session of the reader principal. A session that ended (signed out, expired, the
 * supporter erased) is `not_found`, not `forbidden`: the reader holds the right, the thing it
 * reads is gone, and the front answers with the sign-in form.
 */
const noSession = (): UseCaseError =>
  notFound('standing reader session', 'this cookie on this site');

async function ownSession(ctx: TransactionContext): Promise<ReaderSession> {
  const { actor } = ctx.principal;
  const session =
    actor.kind === 'reader' ? await liveSession(ctx, actor.sessionId, ctx.clock.now()) : null;
  if (!session) throw noSession();
  return session;
}

/**
 * A supporter's grants with their tier names, in the tiers' order: the reader's own page shows
 * them, and so does the admin's page of one supporter (`supporters/timeline.ts`).
 */
export async function accessOf(
  ctx: TransactionContext,
  supporter: SupporterProjection,
  now: Date
): Promise<ReaderAccount['access']> {
  const entries = await Promise.all(
    supporter.grants.map(async (grant) => {
      // A grant on a tier that no longer reads as one opens nothing and shows nothing.
      const tier = await ctx.accessTiers.get(grant.tierId);
      if (!tier) return [];
      return [
        {
          tierId: tier.id,
          name: tier.name,
          kind: tier.kind,
          grantKind: grant.kind,
          until: grant.until,
          standing: grantStands(grant, now),
          order: tier.order,
        },
      ];
    })
  );
  return entries
    .flat()
    .sort((a, b) => a.order - b.order || (a.tierId < b.tierId ? -1 : 1))
    .map(({ order: _order, ...entry }) => entry);
}

export const getReaderAccount = defineUseCase({
  name: 'reader.account.get',
  kind: 'query',
  description:
    'Read the signed-in reader’s own account on this site: the address, the access they hold per tier (also expired), the newsletter lists they are on, the last sign-in and how long the site keeps sign-ins. Only for the reader of the session; nobody else, also not an admin, reads it here.',
  requires: 'content:read',
  actors: ['reader'],
  input: z.object({}).strict(),
  output: ReaderAccount,
  examples: [
    { input: {}, note: 'Runs as the reader of a standing session; anyone else is refused.' },
  ],
  async handler(ctx): Promise<ReaderAccount> {
    const now = ctx.clock.now();
    const session = await ownSession(ctx);
    const supporter = await ctx.supporters.getProjectionById(session.supporterId);
    if (!supporter) throw noSession();
    const { value: retention } = await ctx.siteSettings.retention();
    return {
      email: supporter.email,
      lastSeenAt: supporter.lastSeenAt ?? null,
      sessionExpiresAt: session.expiresAt.toISOString(),
      access: await accessOf(ctx, supporter, now),
      lists: [
        ...supporter.lists.map((list) => ({ list, status: 'confirmed' as const })),
        ...supporter.pendingLists.map((list) => ({ list, status: 'pending' as const })),
      ],
      activityRetentionDays: retention.readerActivityDays,
    };
  },
});

export const withdrawReaderSubscription = defineUseCase({
  name: 'reader.subscription.withdraw',
  kind: 'command',
  description:
    'Take the signed-in reader off one newsletter list on this site, confirmed or still pending, as the unsubscribe link in a mail would: appends newsletter.unsubscribed and the next send leaves them out. A list they are not on is an outcome, not an error.',
  requires: 'content:read',
  actors: ['reader'],
  input: z.object({ list: z.string().min(1).max(200) }).strict(),
  output: z.object({ status: z.enum(['withdrawn', 'not_subscribed']) }),
  examples: [{ input: { list: 'nieuwsbrief' }, note: 'Runs as the reader of a standing session.' }],
  async handler(ctx, { list }) {
    const now = ctx.clock.now();
    const session = await ownSession(ctx);
    const supporter = await lockedLiveSupporter(ctx, session.supporterId);
    if (!supporter) throw noSession();
    if (!onList(supporter, list)) return { status: 'not_subscribed' } as const;
    await withdrawFromList(ctx, supporter, list, 'reader', now);
    return { status: 'withdrawn' } as const;
  },
});
