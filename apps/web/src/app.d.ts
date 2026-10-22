// See https://svelte.dev/docs/kit/types#app.d.ts
import type { OperatorSession, Principal, TenantInfo } from '@mycel/core';
import type { Site } from '#lib/server/site.js';

declare global {
  namespace App {
    interface Locals {
      /** Negotiated locale of the current response; becomes <html lang>. */
      lang?: string;
      /** The site a public request is for, from the hostname or the dev path (hooks.server.ts). */
      site?: Site;
      /** `site.tenant`, for handlers that only need the tenant (ADR 002 rule 3). */
      tenant?: TenantInfo;
      /** The logged-in operator on /admin/*, from the signed session cookie (hooks.server.ts). */
      session?: OperatorSession;
      /** The operator's principal for the tenant in an /admin/[tenant] URL, from the membership. */
      principal?: Principal;
    }
  }
}

export {};
