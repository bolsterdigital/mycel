// The site's consent choice and the tag manager behind it (docs/reference/integrations.md
// § Consent). The server put this tag only on a page whose integration decision placed a tag
// manager, with the container, the category it waits for, the script origins the page's CSP
// allows and the cookie's path on the tag. This file reads the visitor's choice from the
// `mycel_consent` cookie (format: `lib/server/public/scripts/consent.ts`), shows the hidden banner
// while there is none, writes the choice from the banner's buttons, and loads Google Tag Manager
// only when the choice grants the container's category. Before a choice, after refusing and
// without JavaScript nothing reaches Google: no Consent Mode ping either.
//
// Under `require-trusted-types-for 'script'` a script URL needs a policy; GTM sets plain strings.
// This file creates the `default` policy, which the response's CSP allows only on these pages,
// and it lets through only URLs on the origins this page's CSP already names: a tag for a vendor
// the site did not choose is refused twice, by the policy and by the CSP. HTML and inline script
// get no policy, so a custom HTML tag in the container does not run.
// Rejected: loading GTM before the choice with Consent Mode defaults on `denied` (that request
// already tells Google about the visit), and dropping Trusted Types on these pages.
(() => {
  const tag = document.currentScript;
  if (!tag) return;
  const { container, category, scripts = '', path } = tag.dataset;
  if (!container || !category || !path) return;
  const NAME = 'mycel_consent';
  const CATEGORIES = ['analytics', 'marketing'];

  const read = () => {
    for (const part of document.cookie.split(';')) {
      const [name, value = ''] = part.trim().split('=');
      if (name !== NAME) continue;
      const [version, ...rest] = value.split('.');
      if (version === '1') return CATEGORIES.filter((c) => rest.includes(c));
    }
    return null;
  };

  const write = (granted) => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const value = ['1', ...granted].join('.');
    document.cookie = `${NAME}=${value}; Path=${path}; Max-Age=15552000; SameSite=Lax${secure}`;
  };

  const load = (granted) => {
    if (!granted.includes(category)) return;
    const allowed = scripts.split(' ').filter(Boolean);
    const trusted = window.trustedTypes;
    if (trusted && !trusted.defaultPolicy)
      trusted.createPolicy('default', {
        createScriptURL: (url) =>
          allowed.includes(new URL(url, document.baseURI).origin) ? url : null,
      });
    const state = (on) => (on ? 'granted' : 'denied');
    const marketing = state(granted.includes('marketing'));
    const dataLayer = (window.dataLayer = window.dataLayer || []);
    // gtag's own shape: the arguments object, not an array.
    function gtag() {
      dataLayer.push(arguments);
    }
    gtag('consent', 'default', {
      analytics_storage: state(granted.includes('analytics')),
      ad_storage: marketing,
      ad_user_data: marketing,
      ad_personalization: marketing,
    });
    dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(container)}`;
    document.head.append(script);
  };

  const choice = read();
  if (choice) {
    load(choice);
    return;
  }
  const banner = document.querySelector('.consent-banner');
  const form = banner?.querySelector('form');
  if (!banner || !form) return;
  form.addEventListener('submit', (event) => {
    const value = event.submitter?.value;
    if (value !== 'all' && value !== 'necessary') return;
    event.preventDefault();
    const granted = value === 'all' ? CATEGORIES : [];
    write(granted);
    banner.hidden = true;
    // The pressed button is gone; the content after the banner takes the focus.
    const main = document.querySelector('main');
    if (main) {
      main.tabIndex = -1;
      main.focus();
    }
    load(granted);
  });
  banner.hidden = false;
})();
