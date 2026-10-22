// Kysely table types, written by hand next to the SQL migrations they mirror. Rejected:
// kysely-codegen, one more tool and a live database at build time for a handful of tables.

import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** jsonb: pg parses on read; we always JSON.stringify on write (arrays would become pg arrays). */
type Json<T> = ColumnType<T, string, string>;

export interface Database {
  tenants: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
    created_at: Generated<Date>;
  };
  /** View over `tenants` (0008): the five columns mycel_app may read. */
  tenant_directory: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
  };
  tenant_hostnames: {
    hostname: string;
    tenant_id: string;
    kind: 'platform' | 'custom';
    is_primary: Generated<boolean>;
    verification_token: string | null;
    verified_at: Timestamp | null;
    created_at: Generated<Date>;
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
  };
  pages: {
    id: string;
    tenant_id: string;
    slug: string;
    default_locale: string;
    locales: string[];
    title: Json<Record<string, string>>;
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
    sent_at: Timestamp | null;
    provider_id: string | null;
    last_error: string | null;
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
}
