// Kysely table types, written by hand next to the SQL migrations they mirror. Rejected:
// kysely-codegen, one more tool and a live database at build time for a handful of tables.

import type { ConnectionIntent, ConnectionAttempt } from '@mycel/core';
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** jsonb: pg parses on read; we always JSON.stringify on write (arrays would become pg arrays). */
type Json<T> = ColumnType<T, string, string>;

export interface Database {
  site_settings: {
    tenant_id: string;
    theme: Json<unknown>;
    theme_version: number;
    chrome: Json<unknown>;
    chrome_version: number;
  };
  connection_intents: {
    id: string;
    tenant_id: string;
    connection_id: string;
    business_id: string;
    connection_version: number;
    credential_version: number;
    source: string;
    mapping_version: string;
    supporter_id: string | null;
    scope: string;
    actor: Json<ConnectionIntent['actor']>;
    key: string;
    state: ConnectionIntent['state'];
    failure: ConnectionIntent['failure'];
    attempts: number;
    revision: number;
    lease_token: string | null;
    lease_until: ColumnType<Date | null, Date | null, Date | null>;
    next_at: Timestamp;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  connection_attempts: {
    id: string;
    tenant_id: string;
    intent_id: string;
    at: Timestamp;
    kind: ConnectionAttempt['kind'];
    outcome: ConnectionAttempt['outcome'];
  };
  connections: {
    id: string;
    tenant_id: string;
    provider: 'webhook' | 'mailchimp';
    account_ref: string | null;
    external_owner: string;
    maintainer: string;
    purpose: string;
    direction: 'outbound' | 'inbound' | 'bidirectional';
    data_authority: 'mycel' | 'external';
    consent_authority: 'mycel' | 'external';
    consent_scopes: Json<string[]>;
    form_ids: string[];
    destination: string | null;
    contract_version: string;
    adapter_version: string;
    state: 'active' | 'paused' | 'disconnected';
    version: number;
    credential_version: number;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  connection_credentials: {
    connection_id: string;
    tenant_id: string;
    ciphertext: string;
    updated_at: Timestamp;
  };
  tenants: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
    created_at: Generated<Date>;
    /** The hoster's document as written (0010); core merges it over the defaults. */
    entitlements: ColumnType<unknown, string | undefined, string>;
    status: ColumnType<'active' | 'suspended', 'active' | 'suspended' | undefined>;
  };
  /** View over `tenants` (0008): the five columns mycel_app may read. */
  tenant_directory: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
  };
  /** Seats reserved by `forms.submit` until ingest writes the projection (0010). */
  supporter_admissions: {
    tenant_id: string;
    email_hash: string;
    admitted_at: Timestamp;
  };
  tenant_hostnames: {
    hostname: string;
    tenant_id: string;
    kind: 'platform' | 'custom';
    is_primary: Generated<boolean>;
    verification_token: string | null;
    verified_at: Timestamp | null;
    created_at: Generated<Date>;
    check_failures: Generated<number>;
    last_checked_at: Timestamp | null;
  };
  forms: {
    id: string;
    tenant_id: string;
    definition: Json<unknown>;
    created_at: Generated<Date>;
  };
  form_submissions: {
    id: string;
    tenant_id: string;
    form_id: string;
    values: Json<Record<string, string | boolean>>;
    locale: string;
    page_url: string | null;
    ip_hash: string | null;
    created_at: Timestamp;
    confirmed_at: Timestamp | null;
    list: string;
    consent_text_version: string;
  };
  content_items: {
    id: string;
    tenant_id: string;
    type: 'page' | 'article';
    slug: string;
    title: Json<Record<string, string>>;
    default_locale: string;
    locales: string[];
    latest_revision_id: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  content_revisions: {
    id: string;
    tenant_id: string;
    item_id: string;
    document: Json<unknown>;
    actor: Json<unknown>;
    provenance: Json<unknown> | null;
    created_at: Timestamp;
  };
  assist_settings: {
    tenant_id: string;
    enabled: boolean;
    allow_restricted: boolean;
    consented_provider: string | null;
    consented_by: string | null;
    consented_at: Timestamp | null;
  };
  assist_suggestions: {
    id: string;
    tenant_id: string;
    item_id: string;
    base_revision_id: string;
    block_id: string;
    locale: string;
    status: 'pending' | 'ready' | 'failed' | 'accepted' | 'dismissed';
    value: string | null;
    failure: 'unavailable' | 'timeout' | 'rejected' | 'invalid-output' | null;
    provider: string;
    requested_by: string | null;
    model: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  assist_usage: {
    tenant_id: string;
    month: string;
    count: number;
  };
  /** Derived from each revision's document on insert (0017); immutable like revisions. */
  content_block_refs: {
    tenant_id: string;
    item_id: string;
    revision_id: string;
    block_id: string | null;
    type: 'form' | 'item' | 'author' | 'section' | 'media';
    ref_id: string;
  };
  content_item_locales: {
    tenant_id: string;
    item_id: string;
    locale: string;
    published_revision_id: string | null;
    published_at: Timestamp | null;
    first_published_at: Timestamp | null;
    scheduled_revision_id: string | null;
    scheduled_for: Timestamp | null;
    schedule_id: string | null;
    /** Generated from the pointers (0011); never written. */
    status: ColumnType<'draft' | 'scheduled' | 'published' | 'unpublished', never, never>;
  };
  authors: {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    bio: Json<Record<string, string>> | null;
    image_id: string | null;
    links: Json<unknown[]>;
    email: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  sections: {
    id: string;
    tenant_id: string;
    slug: string;
    title: Json<Record<string, string>>;
    description: Json<Record<string, string>> | null;
    sort_order: number;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  patterns: {
    id: string;
    tenant_id: string;
    name: Json<Record<string, string>>;
    description: Json<Record<string, string>> | null;
    intended_type: 'page' | 'article';
    blocks: Json<unknown[]>;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  rate_limits: {
    tenant_id: string;
    key: string;
    window_start: Timestamp;
    hits: number;
  };
  login_attempts: {
    key: string;
    window_start: Timestamp;
    hits: number;
  };
  outbox: {
    id: string;
    tenant_id: string;
    type: string;
    occurred_at: Timestamp;
    actor: Json<unknown>;
    props: Json<Record<string, unknown>>;
    created_at: Generated<Date>;
    available_at: Generated<Date>;
    attempts: Generated<number>;
    delivered_to: Generated<string[]>;
    processed_at: Date | null;
    last_error: string | null;
  };
  jobs: {
    id: string;
    tenant_id: string | null;
    type: string;
    key: string;
    run_at: Timestamp;
    payload: Json<unknown>;
    attempts: Generated<number>;
    max_attempts: Generated<number>;
    claimed_at: Timestamp | null;
    done_at: Timestamp | null;
    last_error: string | null;
    created_at: Generated<Date>;
  };
  events: {
    tenant_id: string;
    id: string;
    supporter_id: string;
    schema: string;
    type: string;
    email: string;
    occurred_at: Timestamp;
    source: string;
    source_site: string;
    source_ref: string;
    props: Json<Record<string, unknown>>;
    ingested_at: Generated<Date>;
  };
  supporters: {
    tenant_id: string;
    id: string;
    email: string;
    first_seen: Timestamp;
    last_activity: Timestamp;
    lists: string[];
    pending_lists: string[];
    applied_through_at: Timestamp;
    applied_through_id: string;
    updated_at: Generated<Date>;
  };
  mail_sends: {
    tenant_id: string;
    key: string;
    subscriber: string;
    event_id: string;
    attempted_at: Timestamp | null;
    claimed_until: Timestamp | null;
    attempts: Generated<number>;
    sent_at: Timestamp | null;
    abandoned_at: Timestamp | null;
    provider_id: string | null;
    last_error: string | null;
    correlation: string | null;
    created_at: Generated<Date>;
  };
  operators: {
    id: string;
    issuer: string | null;
    subject: string | null;
    email: string;
    email_verified_at: Timestamp | null;
    name: string | null;
    created_at: Generated<Date>;
    last_login_at: Timestamp | null;
  };
  tenant_memberships: {
    tenant_id: string;
    operator_id: string;
    capabilities: string[];
    created_at: Timestamp;
  };
  api_keys: {
    id: string;
    tenant_id: string;
    name: string;
    prefix: string;
    key_hash: string;
    capabilities: string[];
    created_by: Json<unknown>;
    created_at: Timestamp;
    last_used_at: Timestamp | null;
    revoked_at: Timestamp | null;
  };
  /** The media register (0012); the bytes are in the BlobStore. */
  media: {
    id: string;
    tenant_id: string;
    kind: 'image' | 'document';
    content_type: string;
    filename: string;
    checksum: string;
    /** bigint: pg returns a string. */
    size_bytes: ColumnType<string, number, number>;
    total_bytes: ColumnType<string, number, number>;
    width: number | null;
    height: number | null;
    variants: Json<unknown[]>;
    access: 'public' | 'restricted';
    caption: Json<Record<string, string>>;
    credit: Json<unknown>;
    source: string | null;
    licence: string | null;
    focal: Json<unknown>;
    state: 'ready' | 'failed';
    created_by: Json<unknown>;
    created_at: Timestamp;
    updated_at: Timestamp;
    deleted_at: Timestamp | null;
  };
  media_usages: {
    tenant_id: string;
    media_id: string;
    ref: string;
    block_id: string;
  };
  audit_log: {
    id: string;
    tenant_id: string | null;
    occurred_at: ColumnType<Date, Date | undefined, never>;
    actor_kind: string;
    actor_id: string | null;
    operation: string;
    effect: string | null;
    input_hash: string;
    result: string;
    request_id: string | null;
    subject_id: string | null;
  };
  /** The erasure register (0019): permanent, the hash of the address, never the address. */
  erasures: {
    tenant_id: string;
    supporter_id: string;
    email_hash: string;
    erased_at: Timestamp;
    actor: Json<unknown>;
  };
  /** Which registrations a restic snapshot holds (0021); written by mycel_backup only. */
  erasure_backups: {
    tenant_id: string;
    supporter_id: string;
    snapshot_id: string;
    secured_at: Timestamp;
  };
  /** Archives a tenant administrator asked for (0022); the file is `exports/<tenant>/<id>.tar`. */
  tenant_exports: {
    id: string;
    tenant_id: string;
    requested_by: string;
    requested_at: Generated<Date>;
    status: Generated<'queued' | 'running' | 'ready' | 'failed' | 'expired'>;
    started_at: Date | null;
    heartbeat_at: Date | null;
    finished_at: Date | null;
    size_bytes: ColumnType<string | null, number | null, number | null>;
    sha256: string | null;
    schema_version: string | null;
    error: string | null;
    expires_at: Date | null;
    purged_at: Date | null;
  };
}
