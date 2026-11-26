// The theme module's ports: versioned site settings (theme, chrome, general, images) and brand assets, both
// tenant-owned rows under RLS, plus the processor that turns uploaded bytes into a brand asset.
// Here, like every module, so `TransactionContext` grows in one file per module. Rejected:
// augmenting it from the service files, which hid a port among use cases.

import type { z } from 'zod';
import type { BrandAsset, BrandKind } from './assets.js';
import type { Theme } from './contrast.js';
import type { SiteRetention, SiteRetentionInput } from '../ops/retention.js';
import type { SiteChrome, SiteGeneral, SiteImages } from './settings.js';
import type { SiteFont, SiteFontRole, SiteFontStyle } from './site-fonts.js';

export interface SiteSettingsRepository {
  theme(): Promise<{ version: number; value: z.output<typeof Theme> }>;
  chrome(): Promise<{ version: number; value: SiteChrome }>;
  updateTheme(baseVersion: number, value: z.output<typeof Theme>): Promise<number | null>;
  updateChrome(baseVersion: number, value: SiteChrome): Promise<number | null>;
  general(): Promise<{ version: number; value: SiteGeneral }>;
  updateGeneral(baseVersion: number, value: SiteGeneral): Promise<number | null>;
  images(): Promise<{ version: number; value: SiteImages }>;
  updateImages(baseVersion: number, value: SiteImages): Promise<number | null>;
  retention(): Promise<{ version: number; value: SiteRetention }>;
  updateRetention(baseVersion: number, value: SiteRetentionInput): Promise<number | null>;
}

export interface BrandProcessor {
  logo(bytes: Uint8Array, contentType: string): Promise<BrandAsset>;
  font(bytes: Uint8Array): Promise<void>;
  /**
   * A square, opaque PNG of `size` pixels: the logo derivative centred on `background` (a CSS
   * colour), for the touch icon and the web app manifest.
   */
  icon(logo: Uint8Array, size: number, background: string): Promise<Uint8Array>;
}
/**
 * A site's uploaded fonts, read in the tenant context. The platform writes them outside a use case
 * (`site-fonts.ts`), so the port has no write.
 */
export interface SiteFontsRepository {
  list(): Promise<SiteFont[]>;
  /** One face's bytes, by role, weight and style; null when the site has no such face. */
  face(
    role: SiteFontRole,
    weight: number,
    style: SiteFontStyle
  ): Promise<{ bytes: Uint8Array; sha256: string } | null>;
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
    siteFonts: SiteFontsRepository;
  }
}
