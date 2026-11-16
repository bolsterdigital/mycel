import { describe, expect, it } from 'vitest';
import { atom, rss, xml, type FeedDocument } from './feed.js';

const feed: FeedDocument = {
  title: 'Site & co',
  home: 'https://example.org/',
  self: 'https://example.org/feed.xml',
  locale: 'nl',
  entries: [
    {
      id: '01a1e426-4444-7ed4-913a-6385a500b9f5',
      url: 'https://example.org/articles/a?x=1&y=2',
      title: '</title><script>alert(1)</script>',
      summary: 'Een\u0000 regel',
      date: '2026-11-16T10:00:00.000Z',
    },
  ],
};

describe('feed rendering', () => {
  it('escapes text and URLs and drops what XML 1.0 forbids', () => {
    expect(xml('a & <b> "c" \'d\'\u0001')).toBe('a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;');
    for (const body of [rss(feed), atom(feed)]) {
      expect(body).not.toContain('<script>');
      expect(body).toContain('&lt;/title&gt;&lt;script&gt;');
      expect(body).toContain('a?x=1&amp;y=2');
      expect(body).not.toContain('\u0000');
    }
  });

  it('dates RSS in RFC 822 and Atom in RFC 3339, the newest entry dating the Atom feed', () => {
    expect(rss(feed)).toContain('<pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate>');
    expect(atom(feed)).toContain('<updated>2026-11-16T10:00:00.000Z</updated>');
    expect(atom({ ...feed, entries: [] })).toContain('<updated>1970-01-01T00:00:00.000Z</updated>');
  });
});
