// See https://svelte.dev/docs/kit/types#app.d.ts
import type { OperatorSession, Principal } from '@mycel/core';

declare global {
  namespace App {
    interface Locals {
      /** Negotiated locale of the current response; becomes <html lang>. */
      lang?: string;
      /** The logged-in operator on /admin/*, from the signed session cookie (hooks.server.ts). */
      session?: OperatorSession;
      /** The operator's principal for the tenant in an /admin/[tenant] URL, from the membership. */
      principal?: Principal;
    }
  }
}

export {};
