// The automatable part of the specification.website checklist, as rules over plain HTTP
// responses. spec-checklist.json gives every checklist item a status; the items marked `gate`
// name one of these rules, and apps/web/e2e/quality-corpus.spec.ts runs them on the published
// quality corpus, so a page that loses its canonical, skip link or nosniff fails CI instead of a
// later audit. The rules read markup with regular expressions on purpose: they check what the
// server sends, before any script runs, which is what a crawler and the no-JS project see.
// Rejected: the checklist's own MCP `audit_url` tool (it needs a public URL, which CI and a dev
// machine do not have, and its verdicts would change with its releases) and a DOM parser
// dependency (the checks are about a handful of head elements and headers).

/**
 * @typedef {'page' | 'missing' | 'revalidation' | 'asset' | 'font' | 'negotiation'} Role
 * @typedef {{ role: Role, path: string, status: number, headers: Record<string, string>, body: string, https?: boolean, locale?: string }} Sample
 * @typedef {{ roles: Role[], check: (sample: Sample) => string | null }} Rule
 */

const head = (body) => body.slice(0, Math.max(0, body.search(/<\/head>/i)));
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
const attr = (tag, name) =>
  tag
    .match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    ?.slice(1)
    .find((v) => v !== undefined);
const meta = (html, key, value) =>
  tags(head(html), 'meta').filter((tag) => attr(tag, key)?.toLowerCase() === value);
const links = (html, rel) =>
  tags(head(html), 'link').filter((tag) =>
    (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).includes(rel)
  );
const csp = (sample) => sample.headers['content-security-policy'] ?? '';
const directive = (policy, name) =>
  policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith(`${name} `) || d.toLowerCase() === name);
const absolute = (href) => /^https?:\/\//i.test(href ?? '');
// Body text without comments and scripts, for the structural rules.
const markup = (body) =>
  body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** @type {Record<string, Rule>} */
export const RULES = {
  doctype: {
    roles: ['page', 'missing'],
    check: (s) =>
      /^\s*<!doctype html>/i.test(s.body)
        ? null
        : 'the response does not start with <!doctype html>',
  },
  'html-lang': {
    roles: ['page', 'missing'],
    check: (s) => {
      const lang = attr(tags(s.body, 'html')[0] ?? '', 'lang');
      if (!lang || !BCP47.test(lang)) return `<html> has no valid lang (${lang ?? 'none'})`;
      if (s.locale && lang !== s.locale) return `<html lang="${lang}"> on a ${s.locale} page`;
      return null;
    },
  },
  'meta-charset': {
    roles: ['page', 'missing'],
    check: (s) =>
      /<meta\s+charset\s*=\s*["']?utf-8/i.test(s.body.slice(0, 1024))
        ? null
        : 'no <meta charset="utf-8"> in the first 1024 bytes',
  },
  'meta-viewport': {
    roles: ['page'],
    check: (s) => {
      const content = attr(meta(s.body, 'name', 'viewport')[0] ?? '', 'content') ?? '';
      if (!/width\s*=\s*device-width/i.test(content))
        return 'no viewport meta with width=device-width';
      if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/i.test(content))
        return `the viewport meta blocks zoom (${content})`;
      return null;
    },
  },
  title: {
    roles: ['page'],
    check: (s) => {
      const titles = head(s.body).match(/<title\b[^>]*>([\s\S]*?)<\/title>/gi) ?? [];
      if (titles.length !== 1) return `${titles.length} <title> elements in <head>`;
      return /<title\b[^>]*>\s*<\/title>/i.test(titles[0]) ? 'the <title> is empty' : null;
    },
  },
  'meta-description': {
    roles: ['page'],
    check: (s) =>
      (attr(meta(s.body, 'name', 'description')[0] ?? '', 'content') ?? '').trim()
        ? null
        : 'no non-empty meta description',
  },
  'canonical-url': {
    roles: ['page'],
    check: (s) => {
      const canonical = links(s.body, 'canonical');
      if (canonical.length !== 1) return `${canonical.length} canonical links`;
      return absolute(attr(canonical[0], 'href'))
        ? null
        : 'the canonical link is not an absolute URL';
    },
  },
  'open-graph': {
    roles: ['page'],
    check: (s) => {
      const missing = ['og:title', 'og:description', 'og:url', 'og:type'].filter(
        (p) => !(attr(meta(s.body, 'property', p)[0] ?? '', 'content') ?? '').trim()
      );
      return missing.length ? `missing ${missing.join(', ')}` : null;
    },
  },
  'soft-404': {
    roles: ['missing'],
    check: (s) => (s.status === 404 ? null : `an unknown path answers ${s.status}, not 404`),
  },
  'meta-robots': {
    roles: ['page'],
    check: (s) => {
      const robots = meta(s.body, 'name', 'robots').map((t) => attr(t, 'content') ?? '');
      const header = s.headers['x-robots-tag'] ?? '';
      return [...robots, header].some((v) => /noindex/i.test(v))
        ? 'an indexable page says noindex'
        : null;
    },
  },
  'heading-hierarchy': {
    roles: ['page'],
    check: (s) => {
      const levels = (markup(s.body).match(/<h[1-6]\b/gi) ?? []).map((h) => Number(h[2]));
      if (levels.filter((l) => l === 1).length !== 1)
        return `${levels.filter((l) => l === 1).length} h1 elements`;
      for (let i = 1; i < levels.length; i++)
        if (levels[i] > levels[i - 1] + 1) return `h${levels[i - 1]} is followed by h${levels[i]}`;
      return null;
    },
  },
  'image-alt': {
    roles: ['page'],
    check: (s) => {
      const bare = tags(markup(s.body), 'img').filter((img) => attr(img, 'alt') === undefined);
      return bare.length ? `${bare.length} <img> without alt` : null;
    },
  },
  'skip-links': {
    roles: ['page'],
    check: (s) => {
      const body = markup(s.body).slice(markup(s.body).search(/<body\b/i));
      const first = body.match(/<(a|button|input|select|textarea|summary)\b[^>]*>/i)?.[0] ?? '';
      const href = attr(first, 'href') ?? '';
      if (!href.startsWith('#') || href.length < 2)
        return 'the first focusable element is not a skip link';
      return new RegExp(`\\sid\\s*=\\s*["']${href.slice(1)}["']`).test(body)
        ? null
        : `the skip link points at a missing ${href}`;
    },
  },
  'semantic-html': {
    roles: ['page'],
    check: (s) => {
      const m = markup(s.body);
      const count = (name) => tags(m, name).length;
      if (count('main') !== 1) return `${count('main')} <main> elements`;
      const missing = ['header', 'footer'].filter((name) => !count(name));
      return missing.length ? `no ${missing.join(' or ')} landmark` : null;
    },
  },
  hsts: {
    roles: ['page'],
    check: (s) => {
      if (!s.https) return null;
      const age = Number(
        (s.headers['strict-transport-security'] ?? '').match(/max-age=(\d+)/i)?.[1]
      );
      return age >= 31536000
        ? null
        : 'no Strict-Transport-Security with a max-age of a year over HTTPS';
    },
  },
  'content-security-policy': {
    roles: ['page'],
    check: (s) => {
      const policy = csp(s);
      if (!policy) return 'no Content-Security-Policy';
      const scripts = directive(policy, 'script-src') ?? directive(policy, 'default-src') ?? '';
      if (!scripts) return 'the policy restricts no scripts';
      return /'unsafe-inline'|'unsafe-eval'/.test(scripts)
        ? `scripts are not restricted (${scripts})`
        : null;
    },
  },
  'x-content-type-options': {
    roles: ['page', 'missing'],
    check: (s) =>
      (s.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff'
        ? null
        : 'no X-Content-Type-Options: nosniff',
  },
  'cross-origin-isolation': {
    roles: ['page', 'missing'],
    check: (s) =>
      s.headers['cross-origin-opener-policy'] === 'same-origin' &&
      s.headers['cross-origin-resource-policy'] === 'same-origin'
        ? null
        : 'no Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy: same-origin',
  },
  vary: {
    roles: ['page'],
    check: (s) =>
      /accept-language|cookie/i.test(s.headers['vary'] ?? '')
        ? `a content page has its language in the address but varies on ${s.headers['vary']}`
        : null,
  },
  'frame-ancestors': {
    roles: ['page'],
    check: (s) =>
      directive(csp(s), 'frame-ancestors') ? null : 'the policy has no frame-ancestors',
  },
  'referrer-policy': {
    roles: ['page'],
    check: (s) => (s.headers['referrer-policy'] ? null : 'no Referrer-Policy'),
  },
  'permissions-policy': {
    roles: ['page'],
    check: (s) =>
      /camera=\(\)/.test(s.headers['permissions-policy'] ?? '')
        ? null
        : 'no Permissions-Policy that disables the camera',
  },
  'x-xss-protection': {
    roles: ['page', 'missing'],
    check: (s) => (s.headers['x-xss-protection'] === undefined ? null : 'X-XSS-Protection is sent'),
  },
  'cookie-attributes': {
    roles: ['page', 'missing'],
    check: (s) => {
      const cookies = (s.headers['set-cookie'] ?? '').split('\n').filter(Boolean);
      const weak = cookies.filter(
        (c) =>
          !/;\s*samesite=/i.test(c) ||
          !/;\s*httponly/i.test(c) ||
          (s.https && !/;\s*secure/i.test(c))
      );
      return weak.length ? `${weak.length} cookie(s) without SameSite, HttpOnly or Secure` : null;
    },
  },
  'image-optimization': {
    roles: ['page'],
    check: (s) => {
      for (const img of tags(markup(s.body), 'img')) {
        const src = attr(img, 'src') ?? '';
        if (!attr(img, 'width') || !attr(img, 'height')) return `${src} has no width and height`;
        if (!/\.(webp|avif|svg)(\?|$)/i.test(src) && !src.startsWith('data:'))
          return `${src} is not WebP, AVIF or SVG`;
      }
      return null;
    },
  },
  'cache-control': {
    roles: ['page', 'missing', 'asset'],
    check: (s) => {
      const value = (s.headers['cache-control'] ?? '').toLowerCase();
      if (s.role === 'asset')
        return /max-age=31536000/.test(value) && /immutable/.test(value)
          ? null
          : `the fingerprinted asset ${s.path} is not cached for a year as immutable (${value || 'none'})`;
      return value ? null : `${s.path} has no Cache-Control`;
    },
  },
  'conditional-requests': {
    roles: ['revalidation'],
    check: (s) =>
      s.status === 304 ? null : `If-None-Match with the page's ETag answers ${s.status}, not 304`,
  },
  'font-loading': {
    roles: ['page', 'font'],
    check: (s) => {
      if (s.role === 'font')
        return s.status === 200 && /font\/woff2/.test(s.headers['content-type'] ?? '')
          ? null
          : `${s.path} is not served as font/woff2`;
      const fonts = links(s.body, 'preload').filter((l) => attr(l, 'as') === 'font');
      if (!fonts.length) return 'no font is preloaded';
      return fonts.every(
        (l) => !absolute(attr(l, 'href')) && /\.woff2$/.test(attr(l, 'href') ?? '')
      )
        ? null
        : 'a preloaded font is not a self-hosted WOFF2';
    },
  },
  'script-loading': {
    roles: ['page'],
    check: (s) => {
      const blocking = tags(head(s.body), 'script').filter(
        (t) =>
          !/type\s*=\s*["']?(module|application\/ld\+json)/i.test(t) &&
          !/\s(defer|async)\b/i.test(t)
      );
      return blocking.length ? `${blocking.length} render-blocking <script> in <head>` : null;
    },
  },
  hreflang: {
    roles: ['page'],
    check: (s) => {
      const alternates = links(s.body, 'alternate').filter((l) => attr(l, 'hreflang'));
      const langs = alternates.map((l) => attr(l, 'hreflang'));
      if (!alternates.every((l) => absolute(attr(l, 'href'))))
        return 'an hreflang alternate is not absolute';
      if (s.locale && !langs.includes(s.locale))
        return `no hreflang alternate for its own locale ${s.locale}`;
      return langs.includes('x-default') ? null : 'no x-default alternate';
    },
  },
  'avoid-auto-geo-redirects': {
    roles: ['negotiation'],
    check: (s) =>
      s.status === 200
        ? null
        : `a request with another Accept-Language answers ${s.status}, not the page`,
  },
};

/**
 * The gate items of the checklist that fail on these samples, one line per failure. A rule that
 * applies to a role no sample has is a failure too: a gate that saw nothing proved nothing.
 * @param {{ items: Record<string, { status: string, rule?: string }> }} checklist
 * @param {Sample[]} samples
 */
export function specFailures(checklist, samples) {
  const failures = [];
  const rules = new Set(
    Object.values(checklist.items)
      .filter((item) => item.status === 'gate')
      .map((item) => item.rule)
  );
  for (const name of rules) {
    const rule = RULES[name];
    if (!rule) {
      failures.push(`${name}: no such rule`);
      continue;
    }
    const applicable = samples.filter((s) => rule.roles.includes(s.role));
    if (!applicable.length) failures.push(`${name}: no ${rule.roles.join('/')} sample to check`);
    for (const sample of applicable) {
      const problem = rule.check(sample);
      if (problem) failures.push(`${name} on ${sample.path}: ${problem}`);
    }
  }
  return failures;
}
