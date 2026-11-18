// The browser half of the pageview gate. The review's hard requirement: the script
// reports the server's decision and never the browser's address. A `%2F`-encoded confirm segment
// and a token in a query value pass the route rules (neither is a `confirm` segment or a `token`
// key), so the only thing that keeps them out of Plausible is that the reported URL comes from
// `decision.path`. This runs the real static file in a sandbox whose `location`, `document.URL`,
// `document.referrer`, `document.title`, cookies and storage throw when read.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PLAUSIBLE_EVENT_ENDPOINT, PLAUSIBLE_ORIGIN, pageviewDecision } from '@mycel/core';

const script = readFileSync(
  new URL('../../../../static/_site/pageview.js', import.meta.url),
  'utf8'
);

function forbidden(name: string): never {
  throw new Error(`pageview.js read ${name}`);
}

function run(dataset: Record<string, string> | null) {
  const sent: { url: string; init: RequestInit }[] = [];
  const trap = (name: string) =>
    new Proxy({}, { get: (_, key) => forbidden(`${name}.${String(key)}`) });
  const document = new Proxy(
    { currentScript: dataset ? { dataset } : null },
    {
      get: (target, key) =>
        key === 'currentScript' ? target.currentScript : forbidden(`document.${String(key)}`),
    }
  );
  const context = {
    document,
    location: trap('location'),
    localStorage: trap('localStorage'),
    sessionStorage: trap('sessionStorage'),
    navigator: trap('navigator'),
    JSON,
    fetch: (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(null));
    },
  };
  (context as Record<string, unknown>)['window'] = context;
  runInNewContext(script, context);
  return sent;
}

describe('the pageview script', () => {
  const dataset = {
    endpoint: PLAUSIBLE_EVENT_ENDPOINT,
    domain: 'example.org',
    url: 'https://example.org/articles/over-ons',
  };

  it('sends exactly the decision on its tag, and reads nothing of the page', () => {
    const sent = run(dataset);
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [(typeof sent)[number]];
    expect(url).toBe(PLAUSIBLE_EVENT_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      n: 'pageview',
      u: 'https://example.org/articles/over-ons',
      d: 'example.org',
      r: null,
    });
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('sends nothing without its tag or with a value missing', () => {
    expect(run(null)).toEqual([]);
    expect(run({ ...dataset, url: '' })).toEqual([]);
    expect(run({ endpoint: dataset.endpoint, domain: dataset.domain })).toEqual([]);
  });

  it('gets a path the route rules let through only as the published item', () => {
    // Both pass the route rules; the reported path is rebuilt from the item, so neither the
    // encoded segment nor the query value is in it.
    const decision = pageviewDecision({
      method: 'GET',
      status: 200,
      contentType: null,
      pathname: '/probe/en/articles/a%2Fconfirm',
      search: '?ref=token-0123456789abcdef&utm=x',
      representation: 'published',
      published: {
        type: 'article',
        slug: 'over-ons',
        access: 'public',
        locale: 'en',
        defaultLocale: 'nl',
      },
    });
    expect(decision).toEqual({ eligible: true, path: '/en/articles/over-ons', aggregated: false });
  });
});

describe('the Content-Security-Policy', () => {
  it('lets a page connect to its own origin and the one Plausible origin, nothing else', () => {
    const config = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8');
    const connect = config.match(/'connect-src':\s*\[([^\]]*)\]/)?.[1];
    expect(connect?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([
      'self',
      PLAUSIBLE_ORIGIN,
    ]);
    expect(PLAUSIBLE_EVENT_ENDPOINT.startsWith(`${PLAUSIBLE_ORIGIN}/`)).toBe(true);
    // The script's own origin stays 'self': no third-party script is allowed.
    expect(config).toMatch(/'script-src':\s*\['self'\]/);
  });
});
