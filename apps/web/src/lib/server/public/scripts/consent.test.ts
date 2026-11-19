// The browser half of the consent choice (docs/reference/integrations.md § Consent), run as the
// real static file in a sandbox: without a choice it shows the banner and loads nothing; a choice
// that grants the container's category loads exactly `gtm.js` for that container, after Consent
// Mode defaults that match the choice; any other choice loads nothing; the banner's buttons write
// the cookie in the format the choice page reads; the `default` policy passes only the page's
// script origins. The CSP and the placement are `security-headers.test.ts` and core's
// `integrations.test.ts`; the real browser is e2e `exerciseConsent`.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CONSENT_COOKIE, parseConsent, serializeConsent } from './consent.js';

const script = readFileSync(
  new URL('../../../../../static/_site/consent.js', import.meta.url),
  'utf8'
);

const GTM = 'https://www.googletagmanager.com';

function run(cookie: string, category = 'marketing') {
  const appended: { src: string; async: boolean }[] = [];
  const written: string[] = [];
  let submit: ((event: unknown) => void) | null = null;
  let policy: { createScriptURL: (url: string) => string | null } | null = null;
  const banner = {
    hidden: true,
    querySelector: () => ({
      addEventListener: (_: string, listener: (event: unknown) => void) => (submit = listener),
    }),
  };
  const main = { tabIndex: 0, focus: () => {} };
  const window: Record<string, unknown> = {
    trustedTypes: {
      defaultPolicy: null,
      createPolicy: (name: string, rules: typeof policy) => {
        expect(name).toBe('default');
        policy = rules;
      },
    },
  };
  const document = {
    currentScript: {
      dataset: {
        container: 'GTM-ABC123',
        category,
        scripts: `${GTM} https://a.example`,
        path: '/probe',
      },
    },
    baseURI: 'https://example.org/probe/over-ons',
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      written.push(value);
    },
    querySelector: (selector: string) => (selector === 'main' ? main : banner),
    createElement: () => ({ src: '', async: false }),
    head: { append: (el: { src: string; async: boolean }) => appended.push(el) },
  };
  Object.assign(window, { document, location: { protocol: 'https:' }, URL, Date });
  window['window'] = window;
  runInNewContext(script, window);
  const press = (value: string) => {
    let prevented = false;
    submit!({ submitter: { value }, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { appended, written, banner, press, window, policy: () => policy };
}

describe('the consent script', () => {
  it('shows the banner without a choice and loads nothing', () => {
    const page = run('other=1');
    expect(page.banner.hidden).toBe(false);
    expect(page.appended).toEqual([]);
    expect(page.window['dataLayer']).toBeUndefined();
  });

  it('loads the container after a choice for its category, and only through its origins', () => {
    const page = run(`a=b; ${CONSENT_COOKIE}=1.marketing`);
    expect(page.banner.hidden).toBe(true);
    expect(page.appended).toEqual([{ src: `${GTM}/gtm.js?id=GTM-ABC123`, async: true }]);
    const [consent] = page.window['dataLayer'] as IArguments[];
    expect([...consent!]).toEqual([
      'consent',
      'default',
      {
        analytics_storage: 'denied',
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
      },
    ]);
    const policy = page.policy()!;
    expect(policy.createScriptURL(`${GTM}/gtag/js?id=G-1`)).toBe(`${GTM}/gtag/js?id=G-1`);
    expect(policy.createScriptURL('https://connect.facebook.net/en_US/fbevents.js')).toBeNull();
    expect(policy.createScriptURL('/_site/elsewhere.js')).toBeNull();
  });

  it('loads nothing for necessary only, another category, or an unknown version', () => {
    for (const cookie of ['1', '1.analytics', '2.marketing'])
      expect(run(`${CONSENT_COOKIE}=${cookie}`).appended).toEqual([]);
  });

  it('writes the choice in the format the choice page reads', () => {
    const all = run('');
    expect(all.press('all')).toBe(true);
    expect(all.written).toEqual([
      `${CONSENT_COOKIE}=${serializeConsent(['analytics', 'marketing'])}; Path=/probe; Max-Age=15552000; SameSite=Lax; Secure`,
    ]);
    expect(parseConsent(all.written[0]!.split(';')[0]!.split('=')[1])).toEqual([
      'analytics',
      'marketing',
    ]);
    expect(all.banner.hidden).toBe(true);
    expect(all.appended).toHaveLength(1);

    const refused = run('');
    refused.press('necessary');
    expect(refused.written[0]).toMatch(new RegExp(`^${CONSENT_COOKIE}=1; `));
    expect(refused.appended).toEqual([]);
    // "Choose" is a link; any other submitter posts to the choice page as it would without script.
    expect(run('').press('other')).toBe(false);
  });
});

describe('the cookie format', () => {
  it('reads only its own version and categories', () => {
    expect(parseConsent('1')).toEqual([]);
    expect(parseConsent('1.marketing.analytics.x')).toEqual(['analytics', 'marketing']);
    expect(parseConsent('2.analytics')).toBeNull();
    expect(parseConsent(undefined)).toBeNull();
    expect(serializeConsent(['marketing', 'analytics'])).toBe('1.analytics.marketing');
  });
});
