// Brand bytes are processed behind a port and kept in the tenant's versioned settings row.
// Rejected: public blob keys or user supplied CSS/URLs, which would bypass the site boundary.
import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { UseCaseError } from '../errors.js';
import { base64ToBytes } from '../util/bytes.js';

export const LOGO_LIMIT = 2 * 1024 * 1024;
export const FONT_LIMIT = 1024 * 1024;
export const BrandKind = z.enum(['logo', 'font']);
export type BrandKind = z.infer<typeof BrandKind>;
export interface BrandAsset {
  bytes: Uint8Array;
  contentType: 'image/webp' | 'font/woff2';
  width: number | null;
  height: number | null;
  licence: string | null;
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
    brandAssets: BrandAssetsRepository;
    brandProcessor: BrandProcessor;
  }
}
const fail = (message: string) => new UseCaseError('invalid_input', message);
const Version = z.number().int().nonnegative();
const AssetState = z.object({
  version: Version,
  active: z.boolean(),
  contentType: z.enum(['image/webp', 'font/woff2']).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  licence: z.string().nullable(),
});
const view = (version: number, asset: BrandAsset | null) => ({
  version,
  active: asset !== null,
  contentType: asset?.contentType ?? null,
  width: asset?.width ?? null,
  height: asset?.height ?? null,
  licence: asset?.licence ?? null,
});
export const getBrandAsset = defineUseCase({
  name: 'site.brand.get',
  kind: 'query',
  description: 'Read the active logo or wordmark font metadata of this site.',
  requires: 'content:read',
  input: z.object({ kind: BrandKind }).strict(),
  output: AssetState,
  examples: [{ input: { kind: 'logo' } }],
  handler: async (ctx, { kind }) => {
    const state = await ctx.brandAssets.get(kind);
    return view(state.version, state.asset);
  },
});
export const putBrandAsset = defineUseCase({
  name: 'site.brand.update',
  kind: 'command',
  description: 'Replace a site logo or wordmark font at a known settings version.',
  requires: 'content:write',
  authenticatedOnly: true,
  consumes: null,
  input: z
    .object({
      kind: BrandKind,
      baseVersion: Version,
      contentType: z.string().min(1).max(100),
      bytes: z
        .string()
        .min(1)
        .max(Math.ceil(LOGO_LIMIT / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      licence: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  output: AssetState,
  examples: [
    {
      input: {
        kind: 'logo',
        baseVersion: 0,
        contentType: 'image/png',
        bytes:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      },
    },
  ],
  handler: async (ctx, input) => {
    const bytes = base64ToBytes(input.bytes);
    const limit = input.kind === 'logo' ? LOGO_LIMIT : FONT_LIMIT;
    if (bytes.length > limit) throw fail('site.brand.size');
    let asset: BrandAsset;
    if (input.kind === 'logo') {
      if (input.licence !== undefined) throw fail('site.brand.licence.unexpected');
      try {
        asset = await ctx.brandProcessor.logo(bytes, input.contentType);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('site.brand.')) throw fail(e.message);
        throw e;
      }
    } else {
      if (input.contentType !== 'font/woff2') throw fail('site.brand.type');
      if (!input.licence) throw fail('site.brand.licence.required');
      try {
        await ctx.brandProcessor.font(bytes);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('site.brand.')) throw fail(e.message);
        throw e;
      }
      asset = {
        bytes,
        contentType: 'font/woff2',
        width: null,
        height: null,
        licence: input.licence,
      };
    }
    const version = await ctx.brandAssets.replace(input.kind, input.baseVersion, asset);
    if (version === null) throw new UseCaseError('conflict', 'site.settings.conflict');
    return view(version, asset);
  },
});
export const removeBrandAsset = defineUseCase({
  name: 'site.brand.delete',
  kind: 'command',
  description: 'Remove the active site logo or wordmark font at a known version.',
  requires: 'content:write',
  authenticatedOnly: true,
  input: z.object({ kind: BrandKind, baseVersion: Version }).strict(),
  output: AssetState,
  examples: [{ input: { kind: 'logo', baseVersion: 0 } }],
  handler: async (ctx, { kind, baseVersion }) => {
    const version = await ctx.brandAssets.replace(kind, baseVersion, null);
    if (version === null) throw new UseCaseError('conflict', 'site.settings.conflict');
    return view(version, null);
  },
});
