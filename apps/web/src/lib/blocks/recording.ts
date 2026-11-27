// The media profile's recording on top (ADR 025, amended 2026-11-27; MY-305). The core names the
// first `video` block the reader is served (`ArticleView.video`); this places the rendered block
// in the document header and marks it in the model (`lifted`), so the body skips it while the
// Markdown, the embed check and the anchors keep it where the editor put it. A recording that
// renders nothing (no poster, no playback) is not lifted: the article keeps the Post header with
// its hero and reading time. Rejected: removing the block from the model, which would drop the
// recording from the Markdown and from the page's script decision, and a second component tree
// for the header that would drift from the block's own markup.

import type { ArticleView } from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { momentOf } from '../../../static/_site/read-along.js';
import type { RenderCardRecording, RenderIntro, RenderModel } from './model.js';

/**
 * The header with the page's `?t=` moment on its recording, whole seconds within a day, so the
 * play form carries it and the player starts there also without JavaScript (MY-305). The same
 * forms as the read-along accepts (`190`, `3:10`, `3m10s`); anything else starts at the start.
 */
export function withMoment(intro: RenderIntro, search: string): RenderIntro {
  const moment = momentOf(search);
  if (!intro.recording?.play || moment === null || moment < 1 || moment > 86_400) return intro;
  return { ...intro, recording: { ...intro.recording, start: Math.floor(moment) } };
}

/** A time on the recording as a reader writes it: `3:10`, `1:02:03`. */
export function clockTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pair = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return hours ? `${hours}:${pair(minutes)}:${pair(whole % 60)}` : `${minutes}:${pair(whole % 60)}`;
}

/** The same time as an HTML duration (`<time datetime>`): `PT3M10S`. */
export function isoDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `PT${Math.floor(whole / 60)}M${whole % 60}S`;
}

/** Whole minutes for the meta line: rounded, and at least one for a recording that has any. */
export function durationMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** A card's recording from the read model (`OverviewEntry.recording`), or null for none. */
export function cardRecording(
  recording: { seconds: number | null } | undefined,
  locale: string
): RenderCardRecording | null {
  if (!recording) return null;
  const t = ui(locale);
  const seconds = recording.seconds;
  return {
    label: t('block.overview.recording'),
    duration: seconds
      ? {
          iso: isoDuration(seconds),
          label: t('block.meta.duration').replace('{minutes}', String(durationMinutes(seconds))),
        }
      : null,
  };
}

export function placeRecording(
  intro: RenderIntro,
  model: RenderModel,
  view: ArticleView | undefined
): { intro: RenderIntro; model: RenderModel } {
  const lift = view?.video;
  const block = lift && model.blocks.find((b) => b.id === lift.blockId);
  if (!lift || !intro.article || block?.type !== 'video' || !(block.play || block.poster))
    return { intro, model };
  const minutes = lift.duration && block.duration ? durationMinutes(block.duration) : null;
  return {
    intro: {
      ...intro,
      hero: null,
      header: 'standard',
      recording: block,
      article: {
        ...intro.article,
        readingTime: minutes
          ? ui(model.locale)('block.meta.duration').replace('{minutes}', String(minutes))
          : null,
      },
    },
    model: { ...model, lifted: block.id },
  };
}
