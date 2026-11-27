// The media profile's header placement and the read-along's pure rules (MY-305). The DOM around
// them is proven in the browser (e2e/lib/published/media-profile.ts).
import { describe, expect, it } from 'vitest';
import {
  clockTime as scriptClock,
  findMatches,
  lineAt,
  momentOf,
  shareUrl,
} from '../../../static/_site/read-along.js';
import { blockCopy } from './copy.js';
import type { RenderBlock, RenderIntro, RenderModel } from './model.js';
import { clockTime, durationMinutes, isoDuration, placeRecording } from './recording.js';

const recording: Extract<RenderBlock, { type: 'video' }> = {
  id: 'film',
  type: 'video',
  caption: null,
  title: 'Aflevering',
  duration: 2455,
  poster: null,
  maker: null,
  licence: null,
  watch: null,
  transcript: [{ start: 0, end: 2, text: 'Hallo', speaker: 'Sam' }],
  play: '/_video/nl/article/aflevering/film',
};
const model = (blocks: RenderBlock[]): RenderModel => ({
  locale: 'nl',
  title: 'Aflevering',
  base: '',
  blocks,
  links: {},
  copy: blockCopy('nl'),
});
const intro: RenderIntro = {
  lead: 'Een gesprek',
  hero: { src: '/media/x/w640.avif' } as RenderIntro['hero'],
  header: 'standard',
  article: { portraits: false, initial: false, readingTime: '1 min lezen', authors: [] },
  meta: null,
};
const heading: RenderBlock = { id: 'kop', type: 'heading', text: 'Vooraf' };

describe('the recording on top', () => {
  it('moves the named video into the header with its duration, and marks it for the body', () => {
    const view = {
      header: 'standard' as const,
      portraits: false,
      minutes: 1,
      initial: false,
      video: { blockId: 'film', duration: true },
    };
    const placed = placeRecording(intro, model([heading, recording]), view);
    expect(placed.intro.recording).toBe(recording);
    expect(placed.intro.hero).toBeNull();
    expect(placed.intro.article?.readingTime).toBe('41 min');
    expect(placed.model.lifted).toBe('film');
    // The Markdown and the embed check still see the block where the editor put it.
    expect(placed.model.blocks.map((b) => b.id)).toEqual(['kop', 'film']);
    const hidden = placeRecording(intro, model([recording]), {
      ...view,
      video: { blockId: 'film', duration: false },
    });
    expect(hidden.intro.article?.readingTime).toBeNull();
  });

  it('keeps the Post header when there is no recording to show', () => {
    const view = { header: 'standard' as const, portraits: false, minutes: 1, initial: false };
    const plain = model([heading, recording]);
    expect(placeRecording(intro, plain, view)).toEqual({ intro, model: plain });
    const gone = { ...recording, play: null, poster: null };
    const nothing = placeRecording(intro, model([gone]), {
      ...view,
      video: { blockId: 'film', duration: true },
    });
    expect(nothing.intro).toBe(intro);
    expect(nothing.model.lifted).toBeUndefined();
  });

  it('writes times as a reader does, the same in the page and in the script', () => {
    for (const [seconds, label] of [
      [0, '0:00'],
      [190.9, '3:10'],
      [3723, '1:02:03'],
    ] as const) {
      expect(clockTime(seconds)).toBe(label);
      expect(scriptClock(seconds)).toBe(label);
    }
    expect(isoDuration(190.9)).toBe('PT3M10S');
    expect(durationMinutes(2455)).toBe(41);
    expect(durationMinutes(20)).toBe(1);
  });
});

describe('the read-along', () => {
  it('reads a moment from the address in the forms people write it', () => {
    expect(momentOf('?t=190')).toBe(190);
    expect(momentOf('?t=190.5')).toBe(190.5);
    expect(momentOf('?x=1&t=3:10')).toBe(190);
    expect(momentOf('?t=1:02:03')).toBe(3723);
    expect(momentOf('?t=3m10s')).toBe(190);
    expect(momentOf('?t=1h')).toBe(3600);
    for (const wrong of ['', '?t=', '?t=-4', '?t=3:99', '?t=abc', '?t=m', '?t=1e3'])
      expect(momentOf(wrong)).toBeNull();
  });

  it('finds the line that sounds, also between and before lines', () => {
    const starts = [0, 2.5, 7, 7.2];
    expect(lineAt(starts, -1)).toBe(-1);
    expect(lineAt(starts, 0)).toBe(0);
    expect(lineAt(starts, 5)).toBe(1);
    expect(lineAt(starts, 7.1)).toBe(2);
    expect(lineAt(starts, 600)).toBe(3);
    expect(lineAt([], 3)).toBe(-1);
  });

  it('finds every hit regardless of case, as offsets into each line', () => {
    expect(findMatches(['Belasting en BELASTING', 'geen', 'de belasting'], ' belasting ')).toEqual([
      { line: 0, start: 0, end: 9 },
      { line: 0, start: 13, end: 22 },
      { line: 2, start: 3, end: 12 },
    ]);
    expect(findMatches(['aaa'], 'aa')).toHaveLength(2);
    expect(findMatches(['tekst'], '   ')).toEqual([]);
  });

  it('shares the page itself at a whole second, without other parameters', () => {
    expect(shareUrl('https://site.test/artikelen/x?edition=published#kop', 190.7)).toBe(
      'https://site.test/artikelen/x?t=190'
    );
  });
});
