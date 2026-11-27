// Reusable editorial data is portable. Upload intents and Bunny bindings are local to this
// installation, so a restored video cannot address files in the source site's library.
import { z } from 'zod';
import { localized } from '../i18n/locale.js';
import { MediaLicence } from './model.js';

export const VideoMetadata = z
  .object({
    title: localized(z.string().trim().min(1).max(200)),
    maker: z.string().trim().min(1).max(300),
    licence: MediaLicence,
    watchUrl: z.url({ protocol: /^https$/ }).nullable(),
  })
  .strict();

export type VideoMetadata = z.infer<typeof VideoMetadata>;

export interface VideoRecord {
  id: string;
  posterId: string;
  metadata: VideoMetadata;
  durationSeconds: number | null;
  hasSource: boolean;
  draftTracks?: Partial<Record<string, string>>;
  publishedTracks: Partial<Record<string, string>>;
  /** Chapters per locale (MY-305), a WebVTT chapters track beside the transcript of that locale. */
  draftChapters?: Partial<Record<string, string>>;
  publishedChapters?: Partial<Record<string, string>>;
  createdAt: Date;
  trashedAt: Date | null;
}

export const VideoUploadState = z.enum([
  'reserved',
  'creating',
  'upload',
  'encoding',
  'ready',
  'failed',
  'over-limit',
]);
export type VideoUploadState = z.infer<typeof VideoUploadState>;

export interface VideoUpload {
  videoId: string;
  uploadKey: string;
  libraryId: string;
  providerId: string | null;
  mp4Height: number | null;
  state: VideoUploadState;
  storageBytes: number;
  durationSeconds: number;
}

export const videoSourceKey = (tenantId: string, videoId: string) =>
  `tenants/${tenantId}/video/${videoId}/original`;
