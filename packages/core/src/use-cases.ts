// Every use case in the system, in one list (ADR 009). Fronts call `buildRegistry()`; nothing
// registers itself as an import side effect, so what is exposed is exactly what is listed here.

import {
  getConnectionIntent,
  listConnectionIntents,
  replayConnectionIntent,
  testConnection,
} from './connections/intents.js';
import { listAudit } from './audit/service.js';
import {
  createConnection,
  disconnectConnection,
  getConnection,
  listConnections,
  pauseConnection,
  replaceConnectionCredential,
  resumeConnection,
  updateConnection,
} from './connections/service.js';
import {
  acceptSuggestion,
  dismissSuggestion,
  getAssistSettings,
  getSuggestion,
  listSuggestions,
  suggestAlt,
  updateAssistSettings,
} from './assist/service.js';
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
import {
  findItems,
  insertBlock,
  moveBlock,
  removeBlock,
  setBlockProps,
  splitInsertBlock,
} from './content/operations.js';
import { getPublished } from './content/public.js';
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
import { confirmSubscription, previewConfirmation } from './mailing/service.js';
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
import { closeJob, getOpsStatus, retryJob } from './ops/service.js';
import { UseCaseRegistry, type UseCase } from './registry.js';
import { changeSupporterEmail, getSupporter } from './supporters/service.js';
import { checkThemeUseCase } from './theme/service.js';
import {
  getSiteTheme,
  updateSiteTheme,
  getSiteChrome,
  updateSiteChrome,
} from './theme/settings.js';
import {
  addHostname,
  listHostnames,
  removeHostname,
  setPrimaryHostname,
  verifyHostnameUseCase,
} from './tenants/service.js';
import { listExports, requestExport } from './tenants/exports.js';

export const useCases = {
  getConnectionIntent,
  listConnectionIntents,
  replayConnectionIntent,
  testConnection,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  pauseConnection,
  resumeConnection,
  disconnectConnection,
  replaceConnectionCredential,
  getAssistSettings,
  updateAssistSettings,
  suggestAlt,
  getSuggestion,
  listSuggestions,
  dismissSuggestion,
  acceptSuggestion,
  getPublished,
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
  insertBlock,
  moveBlock,
  removeBlock,
  setBlockProps,
  splitInsertBlock,
  findItems,
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
  previewConfirmation,
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
  requestExport,
  listExports,
  getUsage,
  getEntitlements,
  uploadMedia,
  getMedia,
  listMedia,
  updateMedia,
  deleteMedia,
  listAudit,
  getOpsStatus,
  retryJob,
  closeJob,
  checkTheme: checkThemeUseCase,
  getSiteTheme,
  updateSiteTheme,
  getSiteChrome,
  updateSiteChrome,
} as const;

export function buildRegistry(): UseCaseRegistry {
  const registry = new UseCaseRegistry();
  for (const useCase of Object.values(useCases)) registry.register(useCase as unknown as UseCase);
  return registry;
}
