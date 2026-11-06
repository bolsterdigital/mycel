// What a notification of `attention.list` says and where it leads: one sentence per
// source in the admin's language and the screen where it is solved, shared by the bell's page and
// the dashboard card so the two cannot word one notification differently. A job is named as the
// status page names it, which is why that page takes `taskName` from here.
// Rejected: the sentence from core (copy belongs in the web front's catalog, ADR 007) and a link
// per source to the status page only (an offer is solved in its editor, a connection on its page).
import type { AttentionItem } from '@mycel/core';
import { fill, type UiKey } from '../../../i18n/index.js';

/** Job types with a name in the catalogue; any other type is "other". */
const NAMED = [
  'content.publish',
  'mail.reconcile',
  'tenant.export',
  'media.purge',
  'hostnames.reverify',
  'connections.run',
  'assist.run',
] as const;
type TaskKind = (typeof NAMED)[number] | 'other';

/** A job type's kind in the catalogue: the type itself when it has a name, else `other`. */
export const taskKind = (type: string): TaskKind =>
  NAMED.find((named) => named === type) ?? 'other';

/** A job type in words, as the status page shows it. */
export const taskName = (t: (key: UiKey) => string, type: string) =>
  t(`admin.status.task.${taskKind(type)}` as const);

/** One notification in a sentence. */
export function attentionText(t: (key: UiKey) => string, item: AttentionItem): string {
  const n = (key: 'admin.status.attention.mail' | 'admin.status.attention.erasure') =>
    fill(t(`${key}.${item.count === 1 ? 'one' : 'many'}` as const), { count: String(item.count) });
  switch (item.source) {
    case 'job':
      return fill(t('admin.attention.item.job'), { task: taskName(t, item.detail ?? '') });
    case 'mail':
      return n('admin.status.attention.mail');
    case 'erasure':
      return n('admin.status.attention.erasure');
    case 'connection':
      return fill(t('admin.attention.item.connection'), {
        // The one provider with a name in the catalogue; another shows as core names it.
        provider:
          item.detail === 'webhook' ? t('admin.connections.provider.webhook') : (item.detail ?? ''),
      });
    case 'review':
      return fill(t('admin.attention.item.review'), {
        title: item.detail || t('admin.content.untitled'),
        locale: item.locale ?? '',
      });
  }
}

/** Where a notification is solved, below `/admin/<tenant>`. */
export function attentionHref(base: string, item: AttentionItem): string {
  switch (item.source) {
    case 'job':
      return `${base}/status#jobs`;
    case 'mail':
      return `${base}/status#mail`;
    case 'erasure':
      return `${base}/status#erasures`;
    case 'connection':
      return `${base}/connections/${item.subjectId}`;
    case 'review':
      return `${base}/content/${item.subjectId}?locale=${item.locale}`;
  }
}

/** The sources the Manage entry stands for: what only an administrator can act on. */
export const MANAGE_SOURCES: readonly AttentionItem['source'][] = [
  'job',
  'mail',
  'erasure',
  'connection',
];
