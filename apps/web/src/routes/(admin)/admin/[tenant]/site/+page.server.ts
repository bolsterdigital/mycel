// Native site settings forms (ADR 009, #11 E): posts are checked in core, including contrast
// and baseVersion. Rejected: client-only validation or a free CSS editor.
// The settings of a site in one place (brief #81 PR 3): general (its time zone, #88), the look
// (theme, brand, chrome),
// AI assistance and usage. Assistance and usage ask `tenant:admin`, the look `content:write`, so
// a member sees only the subjects they may open. Rejected: a route per subject (the sub-navigation is
// already one URL per subject) and loading only the current subject's data (the look's four
// reads would become optional in every section of the page, for reads that are cheap).
// The subjects go to the shell as `subnav` (#81-rest, the contract of #87), so they sit under
// "Settings" in the sidebar; rejected: tabs above the form (tabs are for the parts of one item).
import {
  BRAND_LIMITS,
  can,
  Theme,
  SiteChrome,
  useCases,
  UseCaseError,
  type Capability,
} from '@mycel/core';
import { error, fail, redirect } from '@sveltejs/kit';
import { runtime } from '#lib/server/runtime.js';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { saveAssistSettings } from '#lib/server/assist-settings.js';
import { timeZoneOptions } from '#lib/server/time-zones.js';
import type { Actions, PageServerLoad } from './$types';
import { ui, type UiKey } from '../../../../../i18n/index.js';

const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const baseVersion = (data: FormData) => {
  const raw = text(data, 'baseVersion');
  return raw ? Number(raw) : Number.NaN;
};
const report = (e: unknown) => {
  if (!(e instanceof UseCaseError)) throw e;
  return e.code === 'conflict' ? 'conflict' : 'invalid';
};
/** The settings subjects, each its own URL (brief #56 § B); the first is the default. */
const SECTIONS = ['general', 'theme', 'brand', 'chrome', 'assist', 'usage'] as const;
type SiteSection = (typeof SECTIONS)[number];
/** What a subject asks of the member; `tenant:admin` grants `content:write` as well. */
const NEEDS: Record<SiteSection, Capability> = {
  general: 'content:write',
  theme: 'content:write',
  brand: 'content:write',
  chrome: 'content:write',
  assist: 'tenant:admin',
  usage: 'tenant:admin',
};
const SUBJECT: Record<SiteSection, UiKey> = {
  general: 'admin.site.general',
  theme: 'admin.site.theme',
  brand: 'admin.site.brand',
  chrome: 'admin.site.chrome',
  assist: 'admin.assist.title',
  usage: 'admin.dashboard.usage',
};
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const asked = url.searchParams.get('section');
  const section: SiteSection = SECTIONS.find((s) => s === asked) ?? 'general';
  const principal = locals.principal!;
  if (!can(principal, NEEDS[section]))
    error(
      403,
      NEEDS[section] === 'content:write'
        ? 'content:write'
        : ui(locals.lang ?? 'en')('admin.assist.error.forbidden')
    );
  const [general, theme, chrome, logo, font] = await Promise.all([
    runtime().invoker.run(useCases.getSiteGeneral, principal, {}),
    runtime().invoker.run(useCases.getSiteTheme, principal, {}),
    runtime().invoker.run(useCases.getSiteChrome, principal, {}),
    runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'logo' }),
    runtime().invoker.run(useCases.getBrandAsset, principal, { kind: 'font' }),
  ]);
  const assist =
    section === 'assist'
      ? await runtime().invoker.run(useCases.getAssistSettings, principal, {})
      : null;
  const usage =
    section === 'usage' ? await runtime().invoker.run(useCases.getUsage, principal, {}) : null;
  const t = ui(locals.lang ?? 'en');
  const here = url.pathname;
  return {
    section,
    subnav: SECTIONS.filter((s) => can(principal, NEEDS[s])).map((s) => ({
      label: t(SUBJECT[s]),
      href: s === 'general' ? here : `${here}?section=${s}`,
      current: s === section,
    })),
    general,
    zones: section === 'general' ? timeZoneOptions(locals.lang ?? 'en') : [],
    theme,
    chrome,
    logo,
    font,
    assist: assist && {
      settings: assist,
      allowed: principal.entitlements['ai.assist'] && !!assist.provider,
      saved: url.searchParams.has('saved'),
    },
    usage,
  };
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
  general: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) error(403, 'content:write');
    try {
      const result = await runtime().invoker.run(useCases.updateSiteGeneral, principal, {
        baseVersion: baseVersion(data),
        general: { timeZone: text(data, 'timeZone') },
      });
      return { saved: 'general', version: result.version };
    } catch (e) {
      return fail(e instanceof UseCaseError && e.code === 'conflict' ? 409 : 400, {
        action: 'general',
        problem: report(e),
        values: Object.fromEntries(data),
      });
    }
  },
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
        if (!(file instanceof File) || file.size === 0 || file.size > BRAND_LIMITS[kind])
          return fail(400, { action: 'brand', problem: 'invalid' });
        await runtime().invoker.run(useCases.putBrandAsset, principal, {
          kind,
          baseVersion: version,
          contentType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
          ...(kind === 'font' ? { licence: text(data, 'licence') } : {}),
        });
      }
      return { saved: 'brand', kind };
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
  assist: async ({ request, locals, url, params }) => {
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'tenant:admin'))
      error(403, ui(locals.lang ?? 'en')('admin.assist.error.forbidden'));
    const data = await request.formData();
    const failure = await saveAssistSettings(runtime().invoker, principal, data);
    if (failure) {
      const { status, ...values } = failure;
      return fail(status, values);
    }
    redirect(303, `/admin/${tenant.slug}/site?section=assist&saved=1`);
  },
};
