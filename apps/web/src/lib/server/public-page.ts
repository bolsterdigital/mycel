// Turns the published projection of a page into a flat view model of plain strings for the
// renderer. The core chooses the locale among the published ones and returns only that locale
// (`content.page.get`), so components never see a `{ nl, en }` map, an unpublished translation
// never reaches the HTML, and the public pages ship no client-side JavaScript at all. Full
// locale routing and the block renderers come with #8c; until then `rich-text` and `paywall`
// render nothing rather than improvised markup.

import { error } from '@sveltejs/kit';
import {
  UseCaseError,
  anonymousPrincipal,
  pick,
  useCases,
  type FormDefinition,
  type PublishedPage,
  type TenantInfo,
} from '@mycel/core';
import { runtime } from './runtime.js';
import { siteTenant, type Site } from './site.js';

export type FieldView = {
  name: string;
  type: 'email' | 'consent';
  label: string;
  required: boolean;
};
export type BlockView =
  | { kind: 'heading'; text: string }
  | {
      kind: 'signup-form';
      formId: string;
      startedToken: string;
      fields: FieldView[];
      submitLabel: string;
    };

export interface PublicPage {
  tenant: TenantInfo;
  page: PublishedPage;
  locale: string;
  title: string;
  blocks: BlockView[];
  forms: Map<string, FormDefinition>;
}

/** The site comes from the hooks (hostname or dev path, ADR 014), never from a route param. */
export async function loadPublicPage(
  site: Site,
  slug: string,
  acceptLanguage: string | null
): Promise<PublicPage> {
  const { invoker } = runtime();
  const { tenant } = site;
  const reader = anonymousPrincipal(siteTenant(site), ['content:read', 'forms:read']);
  let page: PublishedPage;
  try {
    page = await invoker.run(useCases.getPage, reader, {
      slug,
      ...(acceptLanguage ? { acceptLanguage: acceptLanguage.slice(0, 500) } : {}),
    });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
  const locale = page.locale;
  // Form copy comes from the form definition, which has its own locales; it falls back to the
  // tenant default like before. Page content needs no fallback: it is already one locale.
  const text = (value: Partial<Record<string, string>>) =>
    pick(value, locale, tenant.defaultLocale) ?? '';

  const forms = new Map<string, FormDefinition>();
  const blocks: BlockView[] = [];
  for (const block of page.blocks) {
    switch (block.type) {
      case 'heading':
        blocks.push({ kind: 'heading', text: block.props.text[locale] ?? '' });
        break;
      case 'signup-form': {
        const { form, startedToken } = await invoker.run(useCases.getForm, reader, {
          id: block.props.formId,
        });
        forms.set(form.id, form);
        blocks.push({
          kind: 'signup-form',
          formId: form.id,
          startedToken,
          submitLabel: text(form.submitLabel),
          fields: form.fields.map((f) => ({
            name: f.name,
            type: f.type,
            label: text(f.label),
            required: f.required,
          })),
        });
        break;
      }
      case 'rich-text':
      case 'paywall':
        break;
      default:
        block satisfies never;
    }
  }
  return { tenant, page, locale, title: page.title, blocks, forms };
}
