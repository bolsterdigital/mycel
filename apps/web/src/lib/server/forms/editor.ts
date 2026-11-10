// Editor choices reuse the authoring registry and its names, rather than duplicating definitions
// in blocks. Keep the existing forms:read presentation boundary and raw reference fallback.
import {
  can,
  formDefinitionName,
  useCases,
  type Block,
  type FormDefinition,
  type Principal,
} from '@mycel/core';
import { runtime } from '../runtime.js';
import { orNull } from '../admin/admin-actions.js';

export async function editorForms(
  principal: Principal,
  blocks: readonly Block[],
  locale: string,
  fallback: string
) {
  const definitions = new Map<string, FormDefinition | null>();
  if (!can(principal, 'forms:read')) return { definitions, choices: null };
  const { invoker } = runtime();
  if (can(principal, 'content:write')) {
    const { forms } = await invoker.run(useCases.listForms, principal, {});
    for (const form of forms) definitions.set(form.id, form);
    for (const block of blocks) {
      if (
        (block.type === 'form' || block.type === 'signup-form') &&
        !definitions.has(block.props.formId)
      )
        definitions.set(block.props.formId, null);
    }
    return {
      definitions,
      choices: forms.map((form) => ({
        id: form.id,
        label: formDefinitionName(form, locale, fallback),
      })),
    };
  }
  for (const block of blocks) {
    if (
      (block.type !== 'form' && block.type !== 'signup-form') ||
      definitions.has(block.props.formId)
    )
      continue;
    const found = await orNull(
      invoker.run(useCases.getForm, principal, { id: block.props.formId })
    );
    definitions.set(block.props.formId, found?.form ?? null);
  }
  return { definitions, choices: null };
}
