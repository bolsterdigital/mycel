// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Locals {
      /** Negotiated locale of the current response; becomes <html lang>. */
      lang?: string;
    }
  }
}

export {};
