// Native site settings forms (ADR 009, #11 E): posts are checked in core, including contrast
// and baseVersion. Rejected: client-only validation or a free CSS editor.
import { can, Theme, SiteChrome, useCases, UseCaseError } from '@mycel/core';
import { error, fail } from '@sveltejs/kit';
import { runtime } from '#lib/server/runtime.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import type { Actions, PageServerLoad } from './$types';

const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const baseVersion = (data: FormData) => {
  const raw = text(data, 'baseVersion');
  return raw ? Number(raw) : Number.NaN;
};
const report = (e: unknown) => {
  if (!(e instanceof UseCaseError)) throw e;
  return e.code === 'conflict' ? 'conflict' : 'invalid';
};
export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:write')) error(403, 'content:write');
  const [theme, chrome] = await Promise.all([
    runtime().invoker.run(useCases.getSiteTheme, principal, {}),
    runtime().invoker.run(useCases.getSiteChrome, principal, {}),
  ]);
  return { theme, chrome };
};
const lines = (raw: string) =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [href = '', nl = '', en = ''] = line.split('|').map((part) => part.trim());
      return { href, label: { nl, en } };
    });
export const actions: Actions = {
  theme: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'content:write');
    const palettes: Record<string, Record<string, unknown>> = {};
    for (const mode of ['light', 'dark']) {
      const palette: Record<string, unknown> = {};
      for (const role of ['body', 'surface', 'primary', 'accent', 'muted', 'warning'])
        palette[role] = {
          foreground: text(data, `${mode}.${role}.foreground`),
          background: text(data, `${mode}.${role}.background`),
        };
      palette['link'] = text(data, `${mode}.link`);
      palette['focus'] = text(data, `${mode}.focus`);
      palettes[mode] = palette;
    }
    const theme = {
      version: 1,
      palettes,
      fontPair: text(data, 'fontPair'),
      baseSize: Number(text(data, 'baseSize')),
      scaleRatio: Number(text(data, 'scaleRatio')),
      measure: Number(text(data, 'measure')),
      radius: Number(text(data, 'radius')),
      density: Number(text(data, 'density')),
      headingWeight: Number(text(data, 'headingWeight')),
    };
    try {
      const result = await runtime().invoker.run(useCases.updateSiteTheme, principal, {
        baseVersion: baseVersion(data),
        theme: theme as Theme,
      });
      return { saved: 'theme', version: result.version };
    } catch (e) {
      return fail(e instanceof UseCaseError && e.code === 'conflict' ? 409 : 400, {
        action: 'theme',
        problem: report(e),
        values: Object.fromEntries(data),
      });
    }
  },
  chrome: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'content:write');
    const optional = (name: string) =>
      text(data, `${name}.href`)
        ? {
            href: text(data, `${name}.href`),
            label: { nl: text(data, `${name}.nl`), en: text(data, `${name}.en`) },
          }
        : null;
    const chrome = {
      navigation: lines(text(data, 'navigation')),
      footer: { nl: text(data, 'footer.nl'), en: text(data, 'footer.en') },
      legal: lines(text(data, 'legal')),
      support: optional('support'),
      help: optional('help'),
    };
    try {
      const result = await runtime().invoker.run(useCases.updateSiteChrome, principal, {
        baseVersion: baseVersion(data),
        chrome: chrome as SiteChrome,
      });
      return { saved: 'chrome', version: result.version };
    } catch (e) {
      return fail(e instanceof UseCaseError && e.code === 'conflict' ? 409 : 400, {
        action: 'chrome',
        problem: report(e),
        values: Object.fromEntries(data),
      });
    }
  },
};
