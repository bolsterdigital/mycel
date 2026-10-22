// Every use case in the system, in one list (ADR 009). Fronts call `buildRegistry()`; nothing
// registers itself as an import side effect, so what is exposed is exactly what is listed here.

import { listAudit } from './audit/service.js';
import {
  createAuthor,
  createPattern,
  createSection,
  getAuthor,
  getPattern,
  getSection,
  listAuthors,
  listPatterns,
  listSections,
  updateAuthor,
  updatePattern,
  updateSection,
} from './content/entities.js';
import { getPage } from './content/public.js';
import {
  createItem,
  diffRevisions,
  getItem,
  listItems,
  listRevisions,
  publishItem,
  scheduleItem,
  unpublishItem,
  unscheduleItem,
  updateItem,
} from './content/service.js';
import { getEntitlements, getUsage } from './entitlements/service.js';
import { getForm, submitForm } from './forms/service.js';
import { confirmSubscription } from './mailing/service.js';
import { deleteMedia, getMedia, listMedia, updateMedia, uploadMedia } from './media/service.js';
import {
  createKey,
  inviteMember,
  listKeys,
  listMembers,
  removeMember,
  revokeKey,
  updateMember,
} from './operators/service.js';
import { UseCaseRegistry, type UseCase } from './registry.js';
import { changeSupporterEmail, getSupporter } from './supporters/service.js';
import {
  addHostname,
  listHostnames,
  removeHostname,
  setPrimaryHostname,
  verifyHostnameUseCase,
} from './tenants/service.js';

export const useCases = {
  getPage,
  createItem,
  updateItem,
  getItem,
  listItems,
  listRevisions,
  diffRevisions,
  publishItem,
  unpublishItem,
  scheduleItem,
  unscheduleItem,
  createAuthor,
  updateAuthor,
  getAuthor,
  listAuthors,
  createSection,
  updateSection,
  getSection,
  listSections,
  createPattern,
  updatePattern,
  getPattern,
  listPatterns,
  getForm,
  submitForm,
  confirmSubscription,
  getSupporter,
  changeSupporterEmail,
  listMembers,
  inviteMember,
  updateMember,
  removeMember,
  listKeys,
  createKey,
  revokeKey,
  listHostnames,
  addHostname,
  verifyHostname: verifyHostnameUseCase,
  setPrimaryHostname,
  removeHostname,
  getUsage,
  getEntitlements,
  uploadMedia,
  getMedia,
  listMedia,
  updateMedia,
  deleteMedia,
  listAudit,
} as const;

export function buildRegistry(): UseCaseRegistry {
  const registry = new UseCaseRegistry();
  for (const useCase of Object.values(useCases)) registry.register(useCase as unknown as UseCase);
  return registry;
}
