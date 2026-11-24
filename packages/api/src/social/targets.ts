// The editor's permalink selects a post within the site's configured profile. Only the
// installation can enable a network or choose a Mastodon server. Keep the same check on the
// worker and read sides so a disabled provider or a changed profile hides old counts too.
import type { SocialProfiles } from '@mycel/core';

const BLUESKY_ORIGIN = 'https://bsky.app';
const BSKY_ACTOR = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+|did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+))$/;

export interface SocialCounts {
  replies?: number;
  reposts?: number;
}

export interface ConversationProviders {
  bluesky: boolean;
  mastodon: ReadonlySet<string>;
}

export type SocialTarget =
  | { network: 'bluesky'; key: string; actor: string; post: string }
  | { network: 'mastodon'; key: string; origin: string; actor: string; post: string };

function httpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.port && !url.username && !url.password ? url : null;
}

export function mastodonOrigin(value: string): boolean {
  const url = httpsUrl(value);
  return (
    url !== null &&
    value === url.origin &&
    /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname) &&
    url.origin !== BLUESKY_ORIGIN
  );
}

export function socialTarget(
  href: string,
  profiles: SocialProfiles | undefined,
  providers: ConversationProviders
): SocialTarget | null {
  const url = httpsUrl(href);
  if (!url) return null;
  if (url.origin === BLUESKY_ORIGIN && providers.bluesky) {
    const own = httpsUrl(profiles?.bluesky);
    const actor = own?.pathname.match(/^\/profile\/([^/]+)\/?$/)?.[1];
    const post = url.pathname.match(/^\/profile\/([^/]+)\/post\/([a-zA-Z0-9_~-]{1,128})\/?$/);
    if (
      own?.origin === url.origin &&
      actor &&
      BSKY_ACTOR.test(actor) &&
      post?.[1]?.toLowerCase() === actor
    ) {
      return { network: 'bluesky', key: `${actor}/${post[2]!}`, actor, post: post[2]! };
    }
  }
  if (providers.mastodon.has(url.origin)) {
    const own = httpsUrl(profiles?.mastodon);
    const actor = own?.pathname.match(/^\/@([\w]{1,64})\/?$/)?.[1];
    const post = url.pathname.match(/^\/@([\w]{1,64})\/([1-9]\d{0,29})\/?$/);
    if (own?.origin === url.origin && actor && post?.[1] === actor) {
      return {
        network: 'mastodon',
        key: `${url.origin}/@${actor}/${post[2]!}`,
        origin: url.origin,
        actor,
        post: post[2]!,
      };
    }
  }
  return null;
}
