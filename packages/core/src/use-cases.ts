import { getMailchimpCallback } from './connections/mailchimp/callback.js';
import { inspectMailchimpAccount } from './connections/mailchimp/service.js';
import {
  listForms,
  getFormForAuthoring,
  createForm,
  updateForm,
  listFormSubmissions,
} from './forms/authoring.js';
// Every use case in the system, in one list (ADR 009). Fronts call `buildRegistry()`; nothing
// registers itself as an import side effect, so what is exposed is exactly what is listed here.

import { getFormFeeds, updateFormFeeds, testFormFeed } from './forms/feed/service.js';

import {
  getFormMailSettings,
  updateFormMailSettings,
  previewFormMail,
  getFormMailStatus,
  replayFormMail,
} from './forms/mail-service.js';

import {
  createPersonGroup,
  updatePersonGroup,
  getPersonGroup,
  listPersonGroups,
} from './content/people/service.js';

import {
  getConnectionIntent,
  listConnectionIntents,
  replayConnectionIntent,
  resolveConnectionIntent,
  testConnection,
} from './connections/intents.js';
import { resumeBulk, withdrawBulk, checkBulk } from './content/bulk/execution.js';
import { createBulk, getBulk } from './content/bulk/service.js';
import { deleteItem, listContentTrash, restoreItem } from './content/trash/service.js';
import { listAudit } from './audit/service.js';
import {
  archiveCampaign,
  closeCampaign,
  createCampaign,
  getCampaign,
  getLandingCampaign,
  listCampaigns,
  openCampaign,
  updateCampaign,
  withdrawParticipation,
} from './campaigns/service.js';
import { composeCampaign } from './campaigns/compose.js';
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
  suggestTranslation,
  updateAssistSettings,
} from './assist/service.js';
import {
  createPerson,
  createPattern,
  createSection,
  getPerson,
  getPattern,
  getSection,
  listPeople,
  listPatterns,
  listSections,
  updatePerson,
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
import { convertHero, getHeroConversion } from './content/header/hero-conversion.js';
import { getPublished } from './content/public.js';
import { getPublicPerson, listPublicPeople } from './content/people/public.js';
import {
  approveTranslation,
  createItem,
  diffRevisions,
  duplicateItem,
  getItem,
  listItems,
  listRevisions,
  publishItem,
  scheduleItem,
  unpublishItem,
  unscheduleItem,
  updateItem,
  updateSlug,
} from './content/service.js';
import { listPresence, updatePresence } from './content/presence/service.js';
import { requestContentReview, withdrawContentReview } from './content/review/review.js';
import { getEntitlements, getUsage } from './entitlements/service.js';
import { getForm, submitForm } from './forms/service.js';
import { confirmSubscription, previewConfirmation } from './mailing/service.js';
import {
  bulkDeleteMedia,
  deleteMedia,
  getMedia,
  listMedia,
  listMediaTrash,
  restoreMedia,
  updateMedia,
  uploadMedia,
} from './media/service.js';
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
import { getAttentionSummary, listAttention, updateAttentionSeenAt } from './attention/service.js';
import { UseCaseRegistry, type UseCase } from './registry.js';
import { changeSupporterEmail, getSupporter } from './supporters/service.js';
import { eraseSupporter, getSupporterErasure } from './supporters/erase.js';
import { erasePeople } from './content/people/erase.js';
import { checkThemeUseCase } from './theme/service.js';
import { getBrandAsset, putBrandAsset, removeBrandAsset } from './theme/assets.js';
import {
  getSiteTheme,
  updateSiteTheme,
  getSiteChrome,
  updateSiteChrome,
  getSiteGeneral,
  updateSiteGeneral,
  getSiteImages,
  updateSiteImages,
  getSiteRetention,
  updateSiteRetention,
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
  getMailchimpCallback,
  inspectMailchimpAccount,
  listForms,
  getFormForAuthoring,
  createForm,
  updateForm,
  listFormSubmissions,
  getFormFeeds,
  updateFormFeeds,
  testFormFeed,
  getFormMailSettings,
  updateFormMailSettings,
  previewFormMail,
  getFormMailStatus,
  replayFormMail,
  createBulk,
  resumeBulk,
  withdrawBulk,
  checkBulk,
  getBulk,
  getConnectionIntent,
  listConnectionIntents,
  replayConnectionIntent,
  resolveConnectionIntent,
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
  suggestTranslation,
  approveTranslation,
  getSuggestion,
  listSuggestions,
  dismissSuggestion,
  acceptSuggestion,
  getPublished,
  getPublicPerson,
  listPublicPeople,
  createItem,
  duplicateItem,
  updateItem,
  getItem,
  listItems,
  listPresence,
  updatePresence,
  listRevisions,
  diffRevisions,
  publishItem,
  unpublishItem,
  scheduleItem,
  unscheduleItem,
  requestContentReview,
  withdrawContentReview,
  updateSlug,
  insertBlock,
  moveBlock,
  removeBlock,
  setBlockProps,
  splitInsertBlock,
  convertHero,
  getHeroConversion,
  findItems,
  createCampaign,
  composeCampaign,
  updateCampaign,
  openCampaign,
  closeCampaign,
  archiveCampaign,
  getCampaign,
  getLandingCampaign,
  listCampaigns,
  withdrawParticipation,
  createPersonGroup,
  updatePersonGroup,
  getPersonGroup,
  listPersonGroups,
  createPerson,
  updatePerson,
  getPerson,
  listPeople,
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
  eraseSupporter,
  getSupporterErasure,
  erasePeople,
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
  deleteItem,
  restoreItem,
  listContentTrash,
  deleteMedia,
  bulkDeleteMedia,
  restoreMedia,
  listMediaTrash,
  listAudit,
  getOpsStatus,
  retryJob,
  closeJob,
  checkTheme: checkThemeUseCase,
  getSiteTheme,
  updateSiteTheme,
  getSiteChrome,
  updateSiteChrome,
  getSiteGeneral,
  updateSiteGeneral,
  getSiteImages,
  updateSiteImages,
  getSiteRetention,
  updateSiteRetention,
  getBrandAsset,
  putBrandAsset,
  removeBrandAsset,
  getAttentionSummary,
  listAttention,
  updateAttentionSeenAt,
} as const;

export function buildRegistry(): UseCaseRegistry {
  const registry = new UseCaseRegistry();
  for (const useCase of Object.values(useCases)) registry.register(useCase as unknown as UseCase);
  return registry;
}
