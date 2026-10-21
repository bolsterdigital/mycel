// Every use case in the system, in one list (ADR 009). Fronts call `buildRegistry()`; nothing
// registers itself as an import side effect, so what is exposed is exactly what is listed here.

import { createPage, getPage } from './content/service.js';
import { getForm, submitForm } from './forms/service.js';
import { UseCaseRegistry, type UseCase } from './registry.js';
import { getSupporter } from './supporters/service.js';

export const useCases = { getPage, createPage, getForm, submitForm, getSupporter } as const;

export function buildRegistry(): UseCaseRegistry {
  const registry = new UseCaseRegistry();
  for (const useCase of Object.values(useCases)) registry.register(useCase as unknown as UseCase);
  return registry;
}
