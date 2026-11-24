// Store one editorial permalink per network and locale. The schema checks the URL shape without
// contacting a provider or inferring that the post belongs to the site.
import { z } from 'zod';
import { Locale } from '../../i18n/locale.js';
import { isSafeHref } from '../rich-text.js';
import type { BlockDefinition } from '../block-types.js';

const posts = [
  { key: 'blueskyPost', network: 'Bluesky' },
  { key: 'mastodonPost', network: 'Mastodon' },
] as const;

// A published projection keeps an empty map for a field supplied only in another locale.
const httpsPost = (matches: (url: URL) => boolean) =>
  z
    .record(
      Locale,
      z
        .string()
        .max(2048)
        .refine(
          (href) =>
            /^https:\/\//i.test(href) &&
            !/[<>]/.test(href) &&
            isSafeHref(href) &&
            matches(new URL(href)),
          'content.social-conversation.post-url'
        )
    )
    .optional();

const props = z
  .object({
    blueskyPost: httpsPost(
      (url) =>
        url.host === 'bsky.app' && /^\/profile\/[\w.:%-]+\/post\/[\w.~-]+\/?$/.test(url.pathname)
    ),
    mastodonPost: httpsPost(
      (url) =>
        url.hostname.includes('.') &&
        /\.[a-z][a-z0-9-]*$/i.test(url.hostname) &&
        /^\/@[\w]+\/[1-9]\d*\/?$/.test(url.pathname)
    ),
  })
  .strict();

export const socialConversationDefinition: BlockDefinition<typeof props, 1> = {
  version: 1,
  props,
  fields: posts.map(({ key }) => ({ key, kind: 'text', localized: true, optional: 'omit' })),
  variants: {},
  localized: (value) =>
    posts.flatMap(({ key }) => {
      const links = value[key];
      return links ? [{ path: [key], value: links, required: false }] : [];
    }),
  references: () => [],
  examples: [
    {
      name: 'social-conversation-links',
      note: 'Public HTTPS permalinks using `bsky.app/profile/<account>/post/<id>` and `<instance>/@<account>/<id>`.',
      props: {
        blueskyPost: {
          nl: 'https://bsky.app/profile/otterdam.example/post/3k4duaz5vfs2b',
          en: 'https://bsky.app/profile/otterdam.example/post/3k4duaz5vfs2c',
        },
        mastodonPost: {
          nl: 'https://social.example.org/@otterdam/123456789',
          en: 'https://social.example.org/@otterdam/123456790',
        },
      },
    },
  ],
};

export function socialConversationLinks(value: z.infer<typeof props>, locale: string) {
  return posts.flatMap(({ key, network }) => {
    const href = value[key]?.[locale];
    return href ? [{ network, href }] : [];
  });
}
