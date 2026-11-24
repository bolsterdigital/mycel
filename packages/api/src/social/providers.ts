// Fixed provider endpoints return counts for a matching public author and post. Keep the result
// small so provider HTML, attachments and credentials never reach Mycel's read model.
import { z } from 'zod';
import type { PublicJson } from './public-json.js';
import type { SocialCounts, SocialTarget } from './targets.js';

const profileError = z.object({ error: z.string(), message: z.string().optional() });
const APP_VIEW = 'https://public.api.bsky.app';
const integerCount = z.number().int().min(0).max(2147483647);
const did = z.string().regex(/^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/);
const labels = z.array(z.object({ val: z.string(), neg: z.boolean().optional() })).optional();
const profile = z.object({ did, handle: z.string(), labels });
const posts = z.object({
  posts: z.array(
    z.object({
      uri: z.string(),
      author: profile,
      replyCount: integerCount.optional().catch(undefined),
      repostCount: integerCount.optional().catch(undefined),
      labels,
    })
  ),
});
const status = z.object({
  id: z.string(),
  visibility: z.string(),
  url: z.string().nullable(),
  account: z.object({ acct: z.string(), url: z.string() }),
  replies_count: integerCount.optional().catch(undefined),
  reblogs_count: integerCount.optional().catch(undefined),
});

export type CountResult =
  { kind: 'public'; counts: SocialCounts } | { kind: 'withdrawn' } | { kind: 'unavailable' };

const withdrawn = { kind: 'withdrawn' } as const;
const unavailable = { kind: 'unavailable' } as const;
const forbidden = (code: number) => code === 401 || code === 403 || code === 404 || code === 410;
const privateLabel = (values: z.infer<typeof labels>) =>
  values?.some((value) => !value.neg && value.val === '!no-unauthenticated');

function counted(replies?: number, reposts?: number): CountResult {
  return {
    kind: 'public',
    counts: {
      ...(replies === undefined ? {} : { replies }),
      ...(reposts === undefined ? {} : { reposts }),
    },
  };
}

async function bluesky(target: Extract<SocialTarget, { network: 'bluesky' }>, get: PublicJson) {
  const query = new URL('/xrpc/app.bsky.actor.getProfile', APP_VIEW);
  query.searchParams.set('actor', target.actor);
  const account = await get(query);
  if (account.status !== 200) {
    const error = profileError.safeParse(account.body);
    const inactive =
      account.status === 400 &&
      error.success &&
      (error.data.error === 'AccountTakedown' ||
        error.data.error === 'AccountDeactivated' ||
        (error.data.error === 'InvalidRequest' && error.data.message === 'Profile not found'));
    return inactive || forbidden(account.status) ? withdrawn : unavailable;
  }
  const own = profile.safeParse(account.body);
  if (!own.success) return unavailable;
  const identity = target.actor.startsWith('did:') ? own.data.did : own.data.handle;
  if (identity !== target.actor || privateLabel(own.data.labels)) return withdrawn;

  const uri = `at://${own.data.did}/app.bsky.feed.post/${target.post}`;
  const endpoint = new URL('/xrpc/app.bsky.feed.getPosts', APP_VIEW);
  endpoint.searchParams.set('uris', uri);
  const response = await get(endpoint);
  if (response.status !== 200) return forbidden(response.status) ? withdrawn : unavailable;
  const result = posts.safeParse(response.body);
  if (!result.success) return unavailable;
  const post = result.data.posts.find((value) => value.uri === uri);
  if (
    !post ||
    post.author.did !== own.data.did ||
    (!target.actor.startsWith('did:') && post.author.handle !== target.actor) ||
    privateLabel(post.author.labels) ||
    privateLabel(post.labels)
  )
    return withdrawn;
  return counted(post.replyCount, post.repostCount);
}

async function mastodon(target: Extract<SocialTarget, { network: 'mastodon' }>, get: PublicJson) {
  const endpoint = new URL(`/api/v1/statuses/${target.post}`, target.origin);
  const response = await get(endpoint);
  if (response.status !== 200) return forbidden(response.status) ? withdrawn : unavailable;
  const result = status.safeParse(response.body);
  if (!result.success) return unavailable;
  const value = result.data;
  const accountUrl = `${target.origin}/@${target.actor}`;
  if (
    value.id !== target.post ||
    value.visibility !== 'public' ||
    value.account.acct !== target.actor ||
    value.account.url !== accountUrl ||
    value.url !== `${accountUrl}/${target.post}`
  )
    return withdrawn;
  return counted(value.replies_count, value.reblogs_count);
}

export async function requestCounts(target: SocialTarget, get: PublicJson): Promise<CountResult> {
  try {
    return await (target.network === 'bluesky' ? bluesky(target, get) : mastodon(target, get));
  } catch {
    return unavailable;
  }
}
