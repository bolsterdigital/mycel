// Turns a page (block tree with localized fields) into a flat view model of plain strings for the
// renderer. Locale resolution happens here, on the server, so components never see a
// `{ nl, en }` map and the public pages ship no client-side JavaScript at all.

import { error } from '@sveltejs/kit';
import {
  UseCaseError,
  anonymousPrincipal,
  negotiateLocale,
  pick,
  useCases,
  type FormDefinition,
  type Page,
  type TenantInfo,
} from '@mycel/core';
import { runtime } from './runtime.js';

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
  page: Page;
  locale: string;
  title: string;
  blocks: BlockView[];
  forms: Map<string, FormDefinition>;
}

export async function tenantBySlug(slug: string): Promise<TenantInfo> {
  const tenant = await runtime().tenants.findBySlug(slug);
  if (!tenant) error(404, 'Not found');
  return tenant;
}

export async function loadPublicPage(
  tenantSlug: string,
  slug: string,
  acceptLanguage: string | null
): Promise<PublicPage> {
  const { invoker } = runtime();
  const tenant = await tenantBySlug(tenantSlug);
  const reader = anonymousPrincipal(tenant.id, ['content:read', 'forms:read']);
  let page: Page;
  try {
    page = await invoker.run(useCases.getPage, reader, { slug });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') error(404, 'Not found');
    throw e;
  }
  const locale = negotiateLocale(acceptLanguage, page.locales, page.defaultLocale);
  const text = (value: Partial<Record<string, string>>) =>
    pick(value, locale, page.defaultLocale) ?? '';

  const forms = new Map<string, FormDefinition>();
  const blocks: BlockView[] = [];
  for (const block of page.blocks) {
    if (block.type === 'heading') {
      blocks.push({ kind: 'heading', text: text(block.props.text) });
    } else {
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
    }
  }
  return { tenant, page, locale, title: text(page.title), blocks, forms };
}
