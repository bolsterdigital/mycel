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
  const [theme, chrome, logo, font] = await Promise.all([
    runtime().invoker.run(useCases.getSiteTheme, principal, {}),
    runtime().invoker.run(useCases.getSiteChrome, principal, {}),
    runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'logo' }),
    runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'font' }),
  ]);
  return { theme, chrome, logo, font };
};
const localized = (
  data: FormData,
  prefix: string,
  locales: readonly string[],
  previous: Record<string, string> = {}
) => {
  const values = { ...previous };
  for (const locale of locales) {
    const value = text(data, `${prefix}.${locale}`);
    if (value) values[locale] = value;
    else delete values[locale];
  }
  return values;
};
const lines = (raw: string, locales: readonly string[], previous: SiteChrome['navigation']) =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [href = '', ...labels] = line.split('|').map((part) => part.trim());
      const prior = previous.find((item) => item.href === href) ?? previous[index];
      const label = { ...(prior?.label ?? {}) };
      for (const [position, locale] of locales.entries()) {
        const value = labels[position] ?? '';
        if (value) label[locale] = value;
        else delete label[locale];
      }
      return { href, label };
    });
export const actions: Actions = {
  brand: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'content:write');
    const kind = text(data, 'kind');
    if (kind !== 'logo' && kind !== 'font')
      return fail(400, { action: 'brand', problem: 'invalid' });
    try {
      const version = baseVersion(data);
      if (text(data, 'intent') === 'remove') {
        await runtime().invoker.run(useCases.removeBrandAsset, principal, {
          kind,
          baseVersion: version,
        });
      } else {
        const file = data.get('file');
        if (
          !(file instanceof File) ||
          file.size === 0 ||
          file.size > (kind === 'logo' ? 2 * 1024 * 1024 : 1024 * 1024)
        )
          return fail(400, { action: 'brand', problem: 'invalid' });
        await runtime().invoker.run(useCases.putBrandAsset, principal, {
          kind,
          baseVersion: version,
          contentType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
          ...(kind === 'font' ? { licence: text(data, 'licence') } : {}),
        });
      }
      return { saved: 'brand' };
    } catch (e) {
      return fail(e instanceof UseCaseError && e.code === 'conflict' ? 409 : 400, {
        action: 'brand',
        problem: report(e),
      });
    }
  },
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
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'content:write');
    try {
      const current = await runtime().invoker.run(useCases.getSiteChrome, principal, {});
      if (current.version !== baseVersion(data))
        return fail(409, {
          action: 'chrome',
          problem: 'conflict',
          values: Object.fromEntries(data),
        });
      const optional = (name: 'support' | 'help') =>
        text(data, `${name}.href`)
          ? {
              href: text(data, `${name}.href`),
              label: localized(data, name, tenant.locales, current.value[name]?.label),
            }
          : null;
      const chrome = {
        navigation: lines(text(data, 'navigation'), tenant.locales, current.value.navigation),
        footer: localized(data, 'footer', tenant.locales, current.value.footer),
        legal: lines(text(data, 'legal'), tenant.locales, current.value.legal),
        support: optional('support'),
        help: optional('help'),
      };
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
