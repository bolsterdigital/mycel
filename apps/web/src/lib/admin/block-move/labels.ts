// The block head names its own controls in the UI locale, independently of the content locale.
// Keep these together instead of repeating the keys at every head in the document form.
import type { UiKey } from '../../../i18n/index.js';
export const blockCardLabels = (t: (key: UiKey) => string) => ({
  edit: t('admin.block.card.edit'),
  done: t('admin.block.card.done'),
  more: t('admin.block.card.more'),
  block: t('admin.block.card.block'),
  collapse: t('admin.block.card.collapse'),
  expand: t('admin.block.card.expand'),
});

export const blockGroupLabels = (t: (key: UiKey) => string) => ({
  display: t('admin.block.group.display'),
  source: t('admin.block.group.source'),
});
