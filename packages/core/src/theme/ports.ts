// The theme module's ports: versioned site settings (theme and chrome) and brand assets, both
// tenant-owned rows under RLS, plus the processor that turns uploaded bytes into a brand asset.
// Here, like every module, so `TransactionContext` grows in one file per module. Rejected:
// augmenting it from the service files, which hid a port among use cases.

import type { z } from 'zod';
import type { BrandAsset, BrandKind } from './assets.js';
import type { Theme } from './contrast.js';
import type { SiteChrome } from './settings.js';

export interface SiteSettingsRepository {
  theme(): Promise<{ version: number; value: z.output<typeof Theme> }>;
  chrome(): Promise<{ version: number; value: SiteChrome }>;
  updateTheme(baseVersion: number, value: z.output<typeof Theme>): Promise<number | null>;
  updateChrome(baseVersion: number, value: SiteChrome): Promise<number | null>;
}

export interface BrandProcessor {
  logo(bytes: Uint8Array, contentType: string): Promise<BrandAsset>;
  font(bytes: Uint8Array): Promise<void>;
}
export interface BrandAssetsRepository {
  get(kind: BrandKind): Promise<{ version: number; asset: BrandAsset | null }>;
  replace(kind: BrandKind, baseVersion: number, asset: BrandAsset | null): Promise<number | null>;
}

declare module '../ports.js' {
  interface TransactionContext {
    siteSettings: SiteSettingsRepository;
    brandAssets: BrandAssetsRepository;
    brandProcessor: BrandProcessor;
  }
}
