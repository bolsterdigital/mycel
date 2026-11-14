// Where personal data is kept, and what removes it (ADR 019 rule 8, ADR 024, ADR
// 031, ADR 032). `TABLES` beside this file says what an export does with a table; `STORAGE` says
// which of its fields carry a copy of a person, whose, what erases or ends that copy, and how long
// the rows stay. `OFF_TABLE_STORAGE` does the same for what is kept outside the tables: blobs,
// export archives, backups and copies at a provider.
//
// The catalog describes the code as it is, including what is still missing: a copy without a
// route says `planned` and names the open work in `OPEN_WORK`, so nobody reads a gap as covered.
// Conformance holds it to the live schema and the code: every relation and every person-shaped
// column has an entry (storage.conformance.test.ts), the tables `apply` may change are exactly
// its `apply` copies and every copy the erasure fixture leaves is a supporter copy
// (erasures.conformance.test.ts), a `tenant` table sits behind forced RLS (rls.conformance.test.ts),
// and every named use case, job and file exists (storage.test.ts).
// Rejected: a retention field on `TABLES` (one table carries copies of several kinds of person
// with different routes), and prose in docs alone (nothing fails when a migration adds a table).

import type { Database } from '../infra/schema.js';
import { NAVIGATION_STORAGE } from './storage-navigation.js';

/**
 * Whose copy. `supporter`: someone who signed, subscribed or gave, erased on request (ADR 019
 * rule 8). `person`: an entry of the people register (ADR 031), a person-id is no supporter-id.
 * `operator`: someone who logs in to manage a site, or the attribution of what they did.
 * `visitor`: a keyed digest of a connection, no address. `anyone`: free text an editor typed,
 * which may name anyone and is not found from an address.
 */
export type Subject = 'supporter' | 'person' | 'operator' | 'visitor' | 'anyone';

/**
 * What ends a copy. `apply`: the erasure register's apply (`packages/db/src/erasures.ts`).
 * `use-case`: an ordinary use case the tenant runs. `expires`: the retention of the entry removes
 * the row within its term, which is the accepted route for a short-lived copy. `planned`: no route
 * yet; `open` names the work in `OPEN_WORK` that owes it. `excluded`: kept on purpose, for `reason`.
 */
export type ErasureRoute =
  | { kind: 'apply'; does: string }
  | { kind: 'use-case'; useCases: readonly string[]; does: string }
  | { kind: 'expires'; why: string }
  | { kind: 'planned'; open: OpenWork; does: string }
  | { kind: 'excluded'; reason: string };

/** A field that carries a copy: a column, or `column.key` for a key inside a JSON column. */
export interface Copy {
  field: string;
  subject: Subject;
  route: ErasureRoute;
}

/**
 * How long rows stay. `term`: removed after `term` by `by` (a job type, a use case or a file of this
 * repository). `kept`: stays while the thing it belongs to exists, for `why`. `planned`: a decided
 * term not yet enforced, owed by `open`.
 */
export type Retention =
  | { kind: 'term'; term: string; by: string }
  | { kind: 'kept'; why: string }
  | { kind: 'planned'; open: OpenWork; term: string };

export type StorageCategory =
  | 'supporters'
  | 'forms'
  | 'mail'
  | 'connections'
  | 'people'
  | 'media'
  | 'content'
  | 'assist'
  | 'access'
  | 'erasure'
  | 'site'
  | 'platform';

export interface StorageEntry {
  category: StorageCategory;
  /**
   * Who answers for the rows: `tenant`, the organisation that runs the site (its data, behind its
   * tenant boundary), or `installation`, whoever runs this Mycel (its accounts, queues and keys).
   */
  owner: 'tenant' | 'installation';
  /** Every field with a copy of a person; empty when the rows hold none. */
  copies: readonly Copy[];
  retention: Retention;
}

/**
 * The work a `planned` route or term waits for; docs/reference/supporters.md § Where copies are
 * kept says where each is planned. A key leaves this list when the last copy that names it has a
 * route, and storage.test.ts refuses a key nothing names.
 */
export const OPEN_WORK = {
  operators: 'a way to remove an operator account and the actor recorded on what they did',
} as const;
export type OpenWork = keyof typeof OPEN_WORK;

const SUPPORTER_KEPT: Retention = {
  kind: 'kept',
  why: 'the relationship lasts until the supporter is erased',
};
const SITE_KEPT: Retention = { kind: 'kept', why: 'part of the site while the tenant exists' };
const ACTOR: Copy = {
  field: 'actor',
  subject: 'operator',
  route: {
    kind: 'planned',
    open: 'operators',
    does: 'the actor names an operator by id and address; no route removes an operator yet',
  },
};
/** A copy `content.person.erase` reaches through apply (ADR 034, people/erasures.ts). */
const PEOPLE = (field: string, does: string): Copy => ({
  field,
  subject: 'person',
  route: { kind: 'apply', does },
});
/** A person id that stays as an inert reference once the person row is gone (ADR 034 rule 3). */
const INERT_PERSON_ID = (field: string): Copy => ({
  field,
  subject: 'person',
  route: {
    kind: 'excluded',
    reason:
      'an id without its person row identifies nobody; kept so attribution keeps its shape (ADR 034 rule 3)',
  },
});
const FREE_TEXT = (field: string, useCases: readonly string[]): Copy => ({
  field,
  subject: 'anyone',
  route: { kind: 'use-case', useCases, does: 'the tenant edits or removes the text' },
});
/** A copy kept on purpose, for `reason`. */
const KEPT = (field: string, subject: Subject, reason: string): Copy => ({
  field,
  subject,
  route: { kind: 'excluded', reason },
});
const IDS_ONLY: readonly Copy[] = [];

export const STORAGE = {
  site_settings: {
    category: 'site',
    owner: 'tenant',
    copies: [
      FREE_TEXT('chrome', ['site.chrome.update']),
      FREE_TEXT('general', ['site.general.update']),
    ],
    retention: SITE_KEPT,
  },
  connections: {
    category: 'connections',
    owner: 'tenant',
    copies: [
      FREE_TEXT('maintainer', ['connection.update']),
      FREE_TEXT('external_owner', ['connection.update']),
      FREE_TEXT('purpose', ['connection.update']),
    ],
    retention: SITE_KEPT,
  },
  connection_intents: {
    category: 'connections',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'detaches the supporter and blocks what has not reached the provider',
        },
      },
      ACTOR,
    ],
    retention: { kind: 'kept', why: 'reconcile evidence; no term decided' },
  },
  mailchimp_receipts: {
    category: 'connections',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes the receipt' },
      },
      {
        field: 'member_hash',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes the receipt' },
      },
    ],
    retention: { kind: 'kept', why: 'reconcile evidence; no term decided' },
  },
  connection_attempts: {
    category: 'connections',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'attempt log of an intent; no term decided' },
  },
  connection_credentials: {
    category: 'connections',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'until the connection is reconnected or removed' },
  },
  tenants: {
    category: 'platform',
    owner: 'installation',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'the tenant itself' },
  },
  tenant_directory: {
    category: 'platform',
    owner: 'installation',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'a view over tenants and hostnames; stores nothing' },
  },
  operators: {
    category: 'access',
    owner: 'installation',
    copies: [
      {
        field: 'email',
        subject: 'operator',
        route: {
          kind: 'planned',
          open: 'operators',
          does: 'no use case removes an operator account; removing a membership keeps it',
        },
      },
      {
        field: 'name',
        subject: 'operator',
        route: {
          kind: 'planned',
          open: 'operators',
          does: 'no use case removes an operator account; removing a membership keeps it',
        },
      },
      {
        field: 'subject',
        subject: 'operator',
        route: {
          kind: 'planned',
          open: 'operators',
          does: 'the identity provider subject goes with the account',
        },
      },
    ],
    retention: { kind: 'kept', why: 'an account stays until removed; no route yet' },
  },
  tenant_hostnames: {
    category: 'site',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: SITE_KEPT,
  },
  form_feed_settings: {
    category: 'forms',
    owner: 'tenant',
    copies: [ACTOR],
    retention: SITE_KEPT,
  },
  form_mail_settings: {
    category: 'forms',
    owner: 'tenant',
    copies: [FREE_TEXT('value', ['form.mail.update'])],
    retention: SITE_KEPT,
  },
  form_mail_budget: {
    category: 'forms',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'a monthly counter; no term decided' },
  },
  forms: {
    category: 'forms',
    owner: 'tenant',
    copies: [FREE_TEXT('definition', ['form.update'])],
    retention: SITE_KEPT,
  },
  form_submissions: {
    category: 'forms',
    owner: 'tenant',
    copies: [
      {
        field: 'values',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes a submission that carries an erased address' },
      },
      {
        field: 'evaluation',
        subject: 'supporter',
        route: { kind: 'apply', does: 'goes with its submission' },
      },
      {
        field: 'ip_hash',
        subject: 'visitor',
        route: { kind: 'apply', does: 'goes with its submission' },
      },
    ],
    retention: {
      kind: 'term',
      term: '24 calendar months, or the fewer the tenant set (site.retention.update); longer while an open mail or connector effect still reads the submission',
      by: 'retention.apply',
    },
  },
  supporters: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'email',
        subject: 'supporter',
        route: { kind: 'apply', does: 'tombstones the address and empties the lists' },
      },
    ],
    retention: SUPPORTER_KEPT,
  },
  supporter_lifecycles: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'email_hash',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'evidence of an explicit readmission after an erasure, which must survive apply and a restore (ADR 032)',
        },
      },
      KEPT(
        'id',
        'supporter',
        'the pseudonymous id of a readmitted lifecycle, the same evidence as its hash (ADR 032)'
      ),
    ],
    retention: SUPPORTER_KEPT,
  },
  supporter_admissions: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'email_hash',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes the seat of an erased address' },
      },
    ],
    retention: {
      kind: 'term',
      term: '7 days (ADMISSION_WINDOW_MS), removed by the next daily run or the next reservation',
      by: 'retention.apply',
    },
  },
  events: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'email',
        subject: 'supporter',
        route: { kind: 'apply', does: 'tombstones the address and keeps the event (ADR 003)' },
      },
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'the tombstone keeps the stable id, so the fold and the counts stay true (ADR 003 rule 5, ADR 019)',
        },
      },
      {
        field: 'props',
        subject: 'supporter',
        route: { kind: 'apply', does: 'empties the payload' },
      },
    ],
    retention: SUPPORTER_KEPT,
  },
  people: {
    category: 'people',
    owner: 'tenant',
    copies: [
      PEOPLE('name', 'deletes the person row'),
      PEOPLE('slug', 'deletes the person row; the slug is free again'),
      PEOPLE('email', 'deletes the person row'),
      PEOPLE('public_email', 'deletes the person row'),
      PEOPLE('phone', 'deletes the person row'),
      PEOPLE('bio', 'deletes the person row'),
      PEOPLE('links', 'deletes the person row'),
      PEOPLE('role', 'deletes the person row'),
      PEOPLE('organisation', 'deletes the person row'),
      PEOPLE('image_id', 'deletes the reference; the portrait is a media asset (media.delete)'),
    ],
    retention: SITE_KEPT,
  },
  campaigns: {
    category: 'content',
    owner: 'tenant',
    // `erased_count` is a number without an identifier (ADR 033 rule 8), not a copy.
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'archived, never deleted (ADR 033 rule 9)' },
  },
  campaign_participations: {
    category: 'supporters',
    owner: 'tenant',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'deletes the participation and adds a confirmed one to the anonymous erased_count',
        },
      },
    ],
    retention: SUPPORTER_KEPT,
  },
  person_groups: {
    category: 'people',
    owner: 'tenant',
    copies: [FREE_TEXT('name', ['content.person_group.update'])],
    retention: SITE_KEPT,
  },
  person_group_members: {
    category: 'people',
    owner: 'tenant',
    copies: [PEOPLE('person_id', 'deletes the memberships of the person')],
    retention: SITE_KEPT,
  },
  sections: {
    category: 'content',
    owner: 'tenant',
    copies: [
      FREE_TEXT('title', ['content.section.update']),
      FREE_TEXT('description', ['content.section.update']),
    ],
    retention: SITE_KEPT,
  },
  patterns: {
    category: 'content',
    owner: 'tenant',
    copies: [
      FREE_TEXT('name', ['content.pattern.update']),
      FREE_TEXT('description', ['content.pattern.update']),
      FREE_TEXT('blocks', ['content.pattern.update']),
      PEOPLE('blocks', 'nulls the credit name beside an erased person id; the id stays inert'),
    ],
    retention: SITE_KEPT,
  },
  media: {
    category: 'media',
    owner: 'tenant',
    copies: [
      PEOPLE('credit', 'nulls the credit name beside an erased person id; the id stays inert'),
      FREE_TEXT('caption', ['media.update']),
      FREE_TEXT('source', ['media.update']),
      FREE_TEXT('filename', ['media.delete']),
      {
        field: 'created_by',
        subject: 'operator',
        route: ACTOR.route,
      },
    ],
    retention: {
      kind: 'term',
      term: '30 days in the trash (MEDIA_TRASH_RETENTION_MS), else kept',
      by: 'media.orphans',
    },
  },
  media_usages: {
    category: 'media',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: SITE_KEPT,
  },
  content_items: {
    category: 'content',
    owner: 'tenant',
    copies: [FREE_TEXT('title', ['content.item.update'])],
    retention: { kind: 'kept', why: 'a deleted item stays in the trash (ADR 030); no purge yet' },
  },
  content_revisions: {
    category: 'content',
    owner: 'tenant',
    copies: [
      {
        field: 'document',
        subject: 'anyone',
        route: {
          kind: 'excluded',
          reason:
            'revisions are immutable history (ADR 018); a new revision changes the current text',
        },
      },
      PEOPLE(
        'document',
        'nulls the credit name beside an erased person id in every revision, trashed items included; author and credit ids stay inert (ADR 034 rule 4)'
      ),
      ACTOR,
      {
        field: 'provenance',
        subject: 'operator',
        route: ACTOR.route,
      },
    ],
    retention: { kind: 'kept', why: 'immutable history (ADR 018)' },
  },
  content_presence: {
    category: 'content',
    owner: 'tenant',
    copies: [
      {
        field: 'actor',
        subject: 'operator',
        route: { kind: 'expires', why: 'read for about a minute (ADR 029)' },
      },
      {
        field: 'actor_id',
        subject: 'operator',
        route: { kind: 'expires', why: 'read for about a minute (ADR 029)' },
      },
    ],
    retention: { kind: 'term', term: '10 minutes', by: 'rate_limits.sweep' },
  },
  content_bulk_plans: {
    category: 'content',
    owner: 'tenant',
    copies: [ACTOR],
    retention: { kind: 'kept', why: 'durable plan and undo evidence (ADR 028)' },
  },
  content_bulk_plan_items: {
    category: 'content',
    owner: 'tenant',
    copies: [
      KEPT(
        'publication',
        'anyone',
        'durable plan evidence (ADR 028); review notes as they were at freeze'
      ),
      PEOPLE('selection', 'nulls the credit name beside an erased person id in the frozen input'),
      PEOPLE(
        'preview',
        'nulls the credit name beside an erased person id in the candidate and its change values'
      ),
    ],
    retention: { kind: 'kept', why: 'durable plan and undo evidence (ADR 028)' },
  },
  content_bulk_runs: {
    category: 'content',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: { kind: 'kept', why: 'durable plan and undo evidence (ADR 028)' },
  },
  content_bulk_effects: {
    category: 'content',
    owner: 'tenant',
    copies: [
      KEPT(
        'result',
        'anyone',
        'durable undo evidence (ADR 028); item titles and review notes as they were'
      ),
      { field: 'result.actor', subject: 'operator', route: ACTOR.route },
    ],
    retention: { kind: 'kept', why: 'durable plan and undo evidence (ADR 028)' },
  },
  assist_settings: {
    category: 'assist',
    owner: 'tenant',
    copies: [
      {
        field: 'consented_by',
        subject: 'operator',
        route: {
          kind: 'excluded',
          reason: 'who consented to a provider is the evidence of that consent (ADR 021)',
        },
      },
    ],
    retention: SITE_KEPT,
  },
  assist_suggestions: {
    category: 'assist',
    owner: 'tenant',
    copies: [
      {
        field: 'value',
        subject: 'anyone',
        route: { kind: 'expires', why: 'a suggestion is a short-lived copy of editor text' },
      },
      {
        field: 'requested_by',
        subject: 'operator',
        route: { kind: 'expires', why: 'goes with the suggestion' },
      },
    ],
    retention: { kind: 'term', term: '30 days (ASSIST_RETENTION_DAYS)', by: 'assist.retention' },
  },
  assist_usage: {
    category: 'assist',
    owner: 'tenant',
    copies: IDS_ONLY,
    retention: { kind: 'term', term: 'earlier months', by: 'assist.retention' },
  },
  content_item_locales: {
    category: 'content',
    owner: 'tenant',
    copies: [
      FREE_TEXT('review_note', [
        'content.review.withdraw',
        'content.item.publish',
        'content.item.schedule',
      ]),
    ],
    retention: SITE_KEPT,
  },
  content_block_refs: {
    category: 'content',
    owner: 'tenant',
    copies: [INERT_PERSON_ID('ref_id')],
    retention: SITE_KEPT,
  },
  content_search: {
    category: 'content',
    owner: 'tenant',
    copies: [
      FREE_TEXT('title', ['content.item.publish', 'content.item.unpublish']),
      FREE_TEXT('body', ['content.item.publish', 'content.item.unpublish']),
    ],
    retention: {
      kind: 'kept',
      why: 'the search tokens of what is published now; the row goes when the locale is unpublished or a new revision is published',
    },
  },
  ...NAVIGATION_STORAGE,
  tenant_memberships: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'operator_id',
        subject: 'operator',
        route: {
          kind: 'use-case',
          useCases: ['tenant.member.remove'],
          does: 'removes the membership; the operator account stays',
        },
      },
    ],
    retention: { kind: 'kept', why: 'while the operator works on the site' },
  },
  api_keys: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'created_by',
        subject: 'operator',
        route: ACTOR.route,
      },
      KEPT(
        'name',
        'anyone',
        'a label an operator typed; a revoked key stays as a record and no use case renames it'
      ),
    ],
    retention: { kind: 'kept', why: 'a revoked key stays as a record; no term decided' },
  },
  audit_log: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'actor_id',
        subject: 'operator',
        route: { kind: 'expires', why: 'attribution of an action, kept for its term' },
      },
      {
        field: 'subject_id',
        subject: 'supporter',
        route: {
          kind: 'expires',
          why: 'a pseudonymous id without address (supporter.erase audits no address)',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: '400 days (AUDIT_RETENTION_DAYS, at least 30)',
      by: 'audit.retention',
    },
  },
  erasures: {
    category: 'erasure',
    owner: 'tenant',
    copies: [
      {
        field: 'email_hash',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'the register a restore re-applies; it must outlive every backup (ADR 019 rule 8)',
        },
      },
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason: 'the id a restore erases again by, without an address (ADR 019 rule 8)',
        },
      },
      {
        field: 'actor',
        subject: 'operator',
        route: {
          kind: 'excluded',
          reason: 'who registered an erasure is part of the register (ADR 019 rule 8)',
        },
      },
    ],
    retention: { kind: 'kept', why: 'permanent register (ADR 019 rule 8, ADR 032)' },
  },
  person_erasures: {
    category: 'erasure',
    owner: 'tenant',
    copies: [
      KEPT(
        'person_id',
        'person',
        'the id a restore or import erases again by, without a name (ADR 034 rule 2)'
      ),
      KEPT(
        'actor',
        'operator',
        'who registered an erasure is part of the register (ADR 034 rule 2)'
      ),
    ],
    retention: { kind: 'kept', why: 'permanent register (ADR 034 rule 2)' },
  },
  outbox: {
    category: 'mail',
    owner: 'tenant',
    copies: [
      {
        field: 'props',
        subject: 'supporter',
        route: { kind: 'apply', does: 'scrubs the address and personalised mail bodies' },
      },
      {
        field: 'actor',
        subject: 'visitor',
        route: { kind: 'expires', why: 'the anonymous ipHash goes with the event at its term' },
      },
      ACTOR,
    ],
    retention: {
      kind: 'term',
      term: '30 days after processed_at; longer while an open mail.reconcile job reads the event; an event that never processed stays until ops retries it',
      by: 'retention.apply',
    },
  },
  jobs: {
    category: 'mail',
    owner: 'tenant',
    copies: [
      {
        field: 'payload',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes a job whose payload carries an erased address' },
      },
    ],
    retention: {
      kind: 'term',
      term: '30 days after done (JOBS_RETENTION_DAYS); a job that exhausted its attempts stays until ops retries or closes it',
      by: 'jobs.retention',
    },
  },
  mail_sends: {
    category: 'mail',
    owner: 'tenant',
    copies: [
      {
        field: 'subscriber',
        subject: 'supporter',
        route: { kind: 'apply', does: 'deletes the intents of an erased event' },
      },
    ],
    retention: {
      kind: 'term',
      term: 'goes with its outbox event, which is the only way an erasure finds the intent',
      by: 'retention.apply',
    },
  },
  rate_limits: {
    category: 'access',
    owner: 'tenant',
    copies: [
      {
        field: 'key',
        subject: 'supporter',
        route: { kind: 'expires', why: 'a keyed digest that lives a day at most (ADR 019 rule 8)' },
      },
    ],
    retention: { kind: 'term', term: '1 day', by: 'rate_limits.sweep' },
  },
  login_attempts: {
    category: 'access',
    owner: 'installation',
    copies: [
      {
        field: 'key',
        subject: 'visitor',
        route: { kind: 'expires', why: 'a login window key that lives a day at most' },
      },
    ],
    retention: { kind: 'term', term: '1 day', by: 'rate_limits.sweep' },
  },
  erasure_backups: {
    category: 'erasure',
    owner: 'installation',
    copies: [
      {
        field: 'supporter_id',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason: 'records which snapshot holds a registration; no address (ADR 019 rule 8)',
        },
      },
    ],
    retention: { kind: 'kept', why: 'as long as the registration it secures' },
  },
  tenant_exports: {
    category: 'site',
    owner: 'tenant',
    copies: [
      {
        // The row stands for its archive, `exports/<tenant>/<id>.tar` in the blob store.
        field: 'id',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'expires every archive that may hold an erased person; the job deletes the file',
        },
      },
      {
        field: 'requested_by',
        subject: 'operator',
        route: { kind: 'expires', why: 'the row of an archive, kept for its term' },
      },
    ],
    retention: {
      kind: 'term',
      term: 'file 7 days (EXPORT_RETENTION_DAYS), row 365 days',
      by: 'tenant.export.expire',
    },
  },
} as const satisfies Record<keyof Database, StorageEntry>;

/** What is kept outside the tables, with the same fields; `where` says where it lives. */
export interface OffTableStorage extends Omit<StorageEntry, 'category'> {
  where: string;
}

export const OFF_TABLE_STORAGE = {
  'media originals': {
    where: 'the blob store, key per asset (media.ts)',
    owner: 'tenant',
    copies: [
      {
        field: 'pixels',
        subject: 'person',
        route: {
          kind: 'use-case',
          useCases: ['media.delete'],
          does: 'a face is not found from a person id, and a shared image may show others (ADR 034 rule 3); the tenant deletes the asset',
        },
      },
      {
        // An image is re-encoded with stripMetadata (media/service.ts), so EXIF and location are
        // gone before it is stored; a PDF is stored as uploaded, its author field included.
        field: 'metadata',
        subject: 'anyone',
        route: {
          kind: 'use-case',
          useCases: ['media.delete'],
          does: 'a PDF keeps its document metadata until the tenant deletes it',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: 'with the row; a file without a row after a day',
      by: 'media.orphans',
    },
  },
  'media variants': {
    where: 'the blob store, beside each original (variants column)',
    owner: 'tenant',
    copies: [
      {
        field: 'pixels',
        subject: 'person',
        route: { kind: 'use-case', useCases: ['media.delete'], does: 'goes with the original' },
      },
    ],
    retention: { kind: 'term', term: 'with the original', by: 'media.orphans' },
  },
  'export archives': {
    where: 'the blob store, exports/<tenant>/<id>.tar per tenant_exports row',
    owner: 'tenant',
    copies: [
      {
        field: 'archive',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'expires every archive that may hold an erased person; the job deletes the file',
        },
      },
      PEOPLE(
        'archive',
        'expires every archive asked for before a person registration, or all when apply changed anything'
      ),
    ],
    retention: {
      kind: 'term',
      term: '7 days (EXPORT_RETENTION_DAYS)',
      by: 'tenant.export.expire',
    },
  },
  'database snapshots': {
    where: 'restic repository, tag mycel,db (docker/backup/backup.sh)',
    owner: 'installation',
    copies: [
      {
        field: 'snapshot',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'a snapshot is not rewritten; a restore re-applies the register before serving (ADR 019 rule 8)',
        },
      },
      KEPT(
        'snapshot',
        'person',
        'a snapshot is not rewritten; a restore re-applies the person register before serving (ADR 034 rule 2)'
      ),
    ],
    retention: {
      kind: 'term',
      term: 'keep-daily 14, keep-weekly 8, keep-monthly 6 (BACKUP_KEEP_*)',
      by: 'docker/backup/backup.sh',
    },
  },
  'erasure register snapshots': {
    where: 'restic repository, tag mycel,erasures (docker/backup/backup.sh)',
    owner: 'installation',
    copies: [
      {
        field: 'snapshot',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason: 'hashes and ids only; it is what a restore re-applies',
        },
      },
      KEPT(
        'snapshot',
        'person',
        'person ids only; the person register a restore re-applies (ADR 034 rule 2)'
      ),
    ],
    retention: {
      kind: 'term',
      term: 'keep-last 48, keep-daily 14 (ERASURES_KEEP_*)',
      by: 'docker/backup/backup.sh',
    },
  },
  'provider copies': {
    where: 'an external CRM, ESP or mail provider (ADR 024)',
    owner: 'tenant',
    copies: [
      {
        field: 'contact',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'a separate copy with its own owner; apply detaches and blocks, it never claims the provider deleted (ADR 024)',
        },
      },
    ],
    retention: { kind: 'kept', why: 'owned by the provider account, reconciled per connection' },
  },
} as const satisfies Record<string, OffTableStorage>;
