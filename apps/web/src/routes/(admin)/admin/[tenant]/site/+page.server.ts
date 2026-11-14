// Native site settings forms (ADR 009, #11 E): posts are checked in core, including contrast
// and baseVersion. Rejected: client-only validation or a free CSS editor.
// The settings of a site in one place (brief #81 PR 3): general (its time zone, #88), the look
// (theme, brand, chrome),
// AI assistance and usage. Assistance and usage ask `tenant:admin`, the look `content:write`, so
// a member sees only the subjects they may open. Rejected: a route per subject (the sub-navigation is
// already one URL per subject) and loading only the current subject's data (the look's four
// reads would become optional in every section of the page, for reads that are cheap).
// The subjects sit in the sidebar (#81-rest): the look under Settings, assistance, API access and
// usage under Manage (#114, src/lib/admin/nav.ts says which); rejected: tabs above the form (tabs
// are for the parts of one item).
// The brand section also holds the site's default image (#81-rest, `site.image.update` from #86):
// its own form and version, so a save there never overwrites the theme or the logo.
// API access (#101) holds the site's API keys, moved from Members: rare, for administrators only,
// so a subject here rather than a menu item of its own; its actions are those Members had.
// How long submissions are kept (`site.retention.*`, docs/reference/jobs.md § Retention) is a
// section of General for `tenant:admin` only, its own form and version: a shorter term deletes submissions, which is
// not an editor's decision. Rejected: a subject of its own for one field, or the Forms screen,
// which an editor with `forms:read` opens too.
import {
  BRAND_LIMITS,
  can,
  KEY_ROLES,
  KeyCapability,
  offeredCapabilities,
  DROP_CAPS,
  Theme,
  SiteChrome,
  useCases,
  type Capability,
} from '@mycel/core';
import { fail, redirect } from '@sveltejs/kit';
import { act, failureOf, text as field } from '#lib/server/admin/admin-actions.js';
import { postedCapabilities } from '#lib/server/admin/roles.js';
import { runtime } from '#lib/server/runtime.js';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { saveAssistSettings } from '#lib/server/admin/assist-settings.js';
import { timeZoneOptions } from '#lib/server/admin/time-zones.js';
import { mediaChoices } from '#lib/server/content/content-blocks.js';
import type { Actions, PageServerLoad } from './$types';
import { langOf, ui, type UiKey } from '../../../../../i18n/index.js';
import { refuse, refusalOf } from '#lib/server/http/refuse.js';

const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const baseVersion = (data: FormData) => {
  const raw = text(data, 'baseVersion');
  return raw ? Number(raw) : Number.NaN;
};
/** A refused save as a form failure: another save came first, or the same mapping as every page. */
const refused = (e: unknown, action: string, values?: FormData) => {
  const { status, body } = failureOf(refusalOf(e), action, {
    conflict: 'admin.site.conflict',
    invalid: 'admin.site.invalid',
    notFound: 'admin.site.invalid',
  });
  return fail(status, { ...body, ...(values ? { values: Object.fromEntries(values) } : {}) });
};
/** The settings subjects, each its own URL (brief #56 § B); the first is the default. */
const SECTIONS = ['general', 'theme', 'brand', 'chrome', 'assist', 'api', 'usage'] as const;
type SiteSection = (typeof SECTIONS)[number];
/** What a subject asks of the member; `tenant:admin` grants `content:write` as well. */
const NEEDS: Record<SiteSection, Capability> = {
  general: 'content:write',
  theme: 'content:write',
  brand: 'content:write',
  chrome: 'content:write',
  assist: 'tenant:admin',
  api: 'tenant:admin',
  usage: 'tenant:admin',
};
const SUBJECT: Record<SiteSection, UiKey> = {
  general: 'admin.site.general',
  theme: 'admin.site.theme',
  brand: 'admin.site.brand',
  chrome: 'admin.site.chrome',
  assist: 'admin.assist.title',
  api: 'admin.access.title',
  usage: 'admin.dashboard.usage',
};
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  await parent();
  const asked = url.searchParams.get('section');
  const section: SiteSection = SECTIONS.find((s) => s === asked) ?? 'general';
  const principal = locals.principal!;
  if (!can(principal, NEEDS[section])) refuse(403);
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
  const keys =
    section === 'api' ? (await runtime().invoker.run(useCases.listKeys, principal, {})).keys : null;
  const images =
    section === 'brand' ? await runtime().invoker.run(useCases.getSiteImages, principal, {}) : null;
  const retention =
    section === 'general' && can(principal, 'tenant:admin')
      ? await runtime().invoker.run(useCases.getSiteRetention, principal, {})
      : null;
  const chosen = images?.value.defaultImageId;
  const t = ui(langOf(locals));
  return {
    section,
    subject: t(SUBJECT[section]),
    general,
    zones: section === 'general' ? timeZoneOptions(langOf(locals)) : [],
    retention,
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
    api: keys && {
      keys,
      roles: [...KEY_ROLES, 'custom' as const],
      capabilities: offeredCapabilities().filter((c) => c !== 'tenant:admin'),
    },
    images: images && {
      ...images,
      media: await mediaChoices(principal, chosen ? [chosen] : []),
      upload: can(principal, 'media:write'),
    },
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
    if (!can(principal, 'content:write')) refuse(403);
    try {
      const result = await runtime().invoker.run(useCases.updateSiteGeneral, principal, {
        baseVersion: baseVersion(data),
        general: {
          timeZone: text(data, 'timeZone'),
          personPages: text(data, 'personPages') as 'auto' | 'off',
        },
      });
      return { saved: 'general', version: result.version };
    } catch (e) {
      return refused(e, 'general', data);
    }
  },
  retention: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'tenant:admin')) refuse(403);
    try {
      const result = await runtime().invoker.run(useCases.updateSiteRetention, principal, {
        baseVersion: baseVersion(data),
        retention: { submissionMonths: Number(text(data, 'submissionMonths')) },
      });
      return { saved: 'retention', version: result.version };
    } catch (e) {
      return refused(e, 'retention', data);
    }
  },
  brand: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) refuse(403);
    const kind = text(data, 'kind');
    if (kind !== 'logo' && kind !== 'font')
      return fail(400, { action: 'brand', error: 'admin.site.invalid' as const });
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
          return fail(400, { action: 'brand', error: 'admin.site.invalid' as const });
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
      return refused(e, 'brand');
    }
  },
  theme: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) refuse(403);
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
      // The action row's card colours: four optional rows; one with both fields empty is
      // left out, and the rest close up in order. A half-filled row posts as it is, so core
      // refuses it instead of this form guessing the other half.
      const accents = [0, 1, 2, 3]
        .map((i) => ({
          foreground: text(data, `${mode}.cardAccents.${i}.foreground`),
          background: text(data, `${mode}.cardAccents.${i}.background`),
        }))
        .filter((pair) => pair.foreground || pair.background);
      if (accents.length) palette['cardAccents'] = accents;
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
      // Unknown or absent stays absent, so core refuses or defaults it rather than this form.
      dropCap: DROP_CAPS.find((d) => d === text(data, 'dropCap')),
      // A posted face goes to core as it is, so one outside the choice is refused, not dropped;
      // absent stays absent and core defaults it to the body face.
      captionFont: text(data, 'captionFont') || undefined,
    };
    try {
      const result = await runtime().invoker.run(useCases.updateSiteTheme, principal, {
        baseVersion: baseVersion(data),
        theme: theme as Theme,
      });
      return { saved: 'theme', version: result.version };
    } catch (e) {
      return refused(e, 'theme', data);
    }
  },
  images: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) refuse(403);
    try {
      const result = await runtime().invoker.run(useCases.updateSiteImages, principal, {
        baseVersion: baseVersion(data),
        images: { defaultImageId: text(data, 'defaultImageId') || null },
      });
      return { saved: 'images', version: result.version };
    } catch (e) {
      return refused(e, 'images', data);
    }
  },
  chrome: async ({ request, locals, url, params }) => {
    const data = await request.formData();
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'content:write')) refuse(403);
    try {
      const current = await runtime().invoker.run(useCases.getSiteChrome, principal, {});
      if (current.version !== baseVersion(data))
        return fail(409, {
          action: 'chrome',
          error: 'admin.site.conflict' as const,
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
      return refused(e, 'chrome', data);
    }
  },
  assist: async ({ request, locals, url, params }) => {
    const { principal, tenant } = await requireTenantPrincipal(locals, url, params.tenant);
    if (!can(principal, 'tenant:admin')) refuse(403);
    const data = await request.formData();
    const failure = await saveAssistSettings(runtime().invoker, principal, data);
    if (failure) {
      const { status, ...values } = failure;
      return fail(status, values);
    }
    redirect(303, `/admin/${tenant.slug}/site?section=assist&saved=1`);
  },
  createKey: (event) =>
    act(event, 'createKey', { conflict: 'admin.error.invalid' }, async (principal, data) => {
      const name = field(data, 'name');
      const key = await runtime().invoker.run(useCases.createKey, principal, {
        name,
        capabilities: postedCapabilities(data) as KeyCapability[],
      });
      return { action: 'createKey', token: key.token, keyName: name };
    }),
  revokeKey: (event) =>
    act(event, 'revokeKey', { conflict: 'admin.error.notFound' }, async (principal, data) => {
      await runtime().invoker.run(useCases.revokeKey, principal, { id: field(data, 'id') });
      return { action: 'revokeKey', done: 'admin.done.revoked' as const };
    }),
};
