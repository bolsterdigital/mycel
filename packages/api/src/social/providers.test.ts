import { describe, expect, it, vi } from 'vitest';
import { requestCounts } from './providers.js';
import type { PublicJson } from './public-json.js';
import { mastodonOrigin, socialTarget } from './targets.js';

const origin = 'https://social.example.org';
const profile = `${origin}/@demo`;
const link = `${profile}/1234567`;
const handle = 'demo.example.org';
const did = 'did:plc:abcdefghijklmnopqrstuvwx';
const bskyProfile = `https://bsky.app/profile/${handle}`;
const uri = `at://${did}/app.bsky.feed.post/3k4duaz5vfs2b`;
const providers = { bluesky: true, mastodon: new Set([origin]) };
const profiles = { mastodon: profile, bluesky: bskyProfile };

describe('public conversation providers', () => {
  it('derives destinations only from enabled networks and the configured account', () => {
    expect(socialTarget(`${link}?query=ignored#fragment`, profiles, providers)).toEqual(
      socialTarget(link, profiles, providers)
    );
    for (const href of [
      'https://unapproved.example.org/@demo/1234567',
      `${origin}/@other/1234567`,
      `${profile}/00`,
      'https://name@social.example.org/@demo/1234567',
      'https://social.example.org:8443/@demo/1234567',
    ]) {
      expect(socialTarget(href, profiles, providers)).toBeNull();
    }
    expect(socialTarget(link, undefined, providers)).toBeNull();
    expect(socialTarget(link, profiles, { ...providers, mastodon: new Set() })).toBeNull();
    expect(mastodonOrigin(origin)).toBe(true);
    for (const value of [profile, `${origin}/`, 'http://social.example.org', 'https://127.0.0.1']) {
      expect(mastodonOrigin(value)).toBe(false);
    }
  });

  it('requests the exact Mastodon status and checks identity and public visibility', async () => {
    const target = socialTarget(link, profiles, providers)!;
    const status = {
      id: '1234567',
      visibility: 'public',
      url: link,
      account: { acct: 'demo', url: profile },
      replies_count: 0,
      content: '<p>Discarded</p>',
    };
    const get = vi.fn<PublicJson>().mockResolvedValue({ status: 200, body: status });
    expect(await requestCounts(target, get)).toEqual({ kind: 'public', counts: { replies: 0 } });
    expect(get.mock.calls.map(([url]) => url.href)).toEqual([`${origin}/api/v1/statuses/1234567`]);
    for (const changes of [
      { visibility: 'unlisted' },
      { visibility: 'private' },
      { url: null },
      { account: { acct: 'demo@foreign.example', url: profile } },
    ]) {
      get.mockResolvedValueOnce({ status: 200, body: { ...status, ...changes } });
      expect(await requestCounts(target, get)).toEqual({ kind: 'withdrawn' });
    }
    get.mockResolvedValueOnce({ status: 404 });
    expect(await requestCounts(target, get)).toEqual({ kind: 'withdrawn' });
    get.mockResolvedValueOnce({ status: 302 }).mockResolvedValueOnce({ status: 429 });
    expect(await requestCounts(target, get)).toEqual({ kind: 'unavailable' });
    expect(await requestCounts(target, get)).toEqual({ kind: 'unavailable' });
  });

  it('uses the public AppView for identity and reads only the matching AT URI', async () => {
    const target = socialTarget(`${bskyProfile}/post/3k4duaz5vfs2b`, profiles, providers)!;
    const author = { did, handle };
    const post = { uri, author, replyCount: 1, repostCount: 0, record: { text: 'discarded' } };
    const get = vi.fn<PublicJson>();
    get
      .mockResolvedValueOnce({ status: 200, body: author })
      .mockResolvedValueOnce({ status: 200, body: { posts: [post] } });
    expect(await requestCounts(target, get)).toEqual({
      kind: 'public',
      counts: { replies: 1, reposts: 0 },
    });
    const calls = get.mock.calls.map(([url]) => [url.origin, url.pathname, [...url.searchParams]]);
    expect(calls).toEqual([
      ['https://public.api.bsky.app', '/xrpc/app.bsky.actor.getProfile', [['actor', handle]]],
      ['https://public.api.bsky.app', '/xrpc/app.bsky.feed.getPosts', [['uris', uri]]],
    ]);
    for (const body of [
      { posts: [] },
      { posts: [{ ...post, author: { ...author, handle: 'another.example' } }] },
      { posts: [{ ...post, labels: [{ val: '!no-unauthenticated' }] }] },
    ]) {
      get
        .mockResolvedValueOnce({ status: 200, body: author })
        .mockResolvedValueOnce({ status: 200, body });
      expect(await requestCounts(target, get)).toEqual({ kind: 'withdrawn' });
    }
    get.mockResolvedValueOnce({ status: 400, body: { error: 'AccountDeactivated' } });
    expect(await requestCounts(target, get)).toEqual({ kind: 'withdrawn' });
  });
});
