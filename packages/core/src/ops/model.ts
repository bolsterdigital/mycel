// What the status page shows and what an administrator may share with support (TODO #17c,
// brief observability-c-recovery decisions 4 to 6). The diagnosis is plain text the administrator
// reads before sharing it: no "send to support" button anywhere, because that would send what
// nobody has seen. It holds ids, types, counts, times and scrubbed error text; never a payload, a
// correlation hash or a provider id. Rejected: a structured export (JSON) to share, which invites
// adding fields nobody reads before they leave the site.

import { z } from 'zod';
import { scrubText } from '../util/scrub.js';

const Timestamp = z.string().datetime({ offset: true });

export const StuckJobView = z.object({
  id: z.string().guid(),
  type: z.string(),
  key: z.string(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
});
export type StuckJobView = z.infer<typeof StuckJobView>;

/** `unknown`: attempted, outcome not established; `abandoned`: given up, stays visible. */
export const MailIntentState = z.enum(['unknown', 'abandoned']);
export type MailIntentState = z.infer<typeof MailIntentState>;

export const UnresolvedMailView = z.object({
  state: MailIntentState,
  subscriber: z.string(),
  attempts: z.number().int(),
  attemptedAt: Timestamp,
  abandonedAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
});
export type UnresolvedMailView = z.infer<typeof UnresolvedMailView>;

/**
 * The site's erasure register against its backups (TODO #29B): counts only, never an id. `late`
 * when a registration has waited longer than ERASURE_UNSECURED_WARN_MS for a backup to hold it.
 */
export const ErasureBackupView = z.object({
  registered: z.number().int(),
  unsecured: z.number().int(),
  oldestUnsecuredAt: Timestamp.nullable(),
  late: z.boolean(),
});
export type ErasureBackupView = z.infer<typeof ErasureBackupView>;

/** Longest key shown in the diagnosis: enough to recognise the subject, not to reconstruct it. */
export const DIAGNOSIS_KEY_CHARS = 48;

export const keyPrefix = (key: string): string =>
  key.length > DIAGNOSIS_KEY_CHARS ? `${key.slice(0, DIAGNOSIS_KEY_CHARS)}…` : key;

const oneLine = (text: string | null): string =>
  text === null ? '-' : scrubText(text).replace(/\s+/g, ' ').trim();

export interface DiagnosisInput {
  tenantSlug: string;
  at: Date;
  jobs: readonly StuckJobView[];
  mails: readonly UnresolvedMailView[];
  erasures: ErasureBackupView;
  /** Request ids of the most recent refused or failed commands, newest first. */
  failedRequests: readonly string[];
}

/**
 * The text an administrator may copy to support. English and fixed in shape: support reads it,
 * and a translated diagnosis would differ per locale for the same state. Every error text goes
 * through `scrubText` once more, whatever was scrubbed when it was written.
 */
export function buildDiagnosis({
  tenantSlug,
  at,
  jobs,
  mails,
  erasures,
  failedRequests,
}: DiagnosisInput): string {
  const lines = [
    `site: ${tenantSlug}`,
    `at: ${at.toISOString()}`,
    `exhausted jobs: ${jobs.length}`,
  ];
  for (const j of jobs)
    lines.push(
      `- ${j.type} ${keyPrefix(j.key)} attempts ${j.attempts}/${j.maxAttempts} since ${j.createdAt}: ${oneLine(j.lastError)}`
    );
  lines.push(`unresolved mail: ${mails.length}`);
  for (const m of mails)
    lines.push(
      `- ${m.state} ${m.subscriber} attempts ${m.attempts} attempted ${m.attemptedAt}` +
        (m.abandonedAt ? ` abandoned ${m.abandonedAt}` : '') +
        `: ${oneLine(m.lastError)}`
    );
  lines.push(
    `erasures not in a backup: ${erasures.unsecured}` +
      (erasures.oldestUnsecuredAt ? ` oldest since ${erasures.oldestUnsecuredAt}` : '') +
      (erasures.late ? ' (late)' : '')
  );
  lines.push(
    `failed requests: ${failedRequests.length ? failedRequests.map(oneLine).join(' ') : '-'}`
  );
  return lines.join('\n');
}
