import { describe, expect, it } from 'vitest';
import {
  chapterLines,
  chapterList,
  importChapters,
  importTranscript,
  MAX_CHAPTERS,
  transcriptCues,
  transcriptText,
} from './transcript.js';

describe('timed transcript import', () => {
  it('keeps start times, voice names, sound descriptions and escaped text on an edit', () => {
    const track = importTranscript(
      '\uFEFFWEBVTT\r\n\r\na\r\n00:00.100 --> 00:01.110\r\n<v Sam>Along &amp; across\r\n[water]',
      3
    );
    expect(transcriptText(track)).toEqual(['Sam: Along & across\n[water]']);
    expect(track).toContain('<v Sam>Along &amp; across');
    expect(importTranscript(track, 3)).toBe(track);
    expect(track).toContain('00:00:00.100 --> 00:00:01.110');
  });
  it('excludes WebVTT comments from import, search and the readable transcript', () => {
    const track =
      'WEBVTT\n\nNOTE editorial\n00:00.000 --> 00:01.000\nPrivate note\n\n00:00.000 --> 00:02.000\nHello';
    expect(transcriptText(track)).toEqual(['Hello']);
    expect(importTranscript(track, 2)).not.toContain('Private');
  });
  it('ends a timestamped text cue at the next cue or the end of the recording', () => {
    expect(importTranscript('0:00 [Music]\n0:04.2 Sam: Hello.', 9)).toContain(
      '00:00:04.200 --> 00:00:09.000\nSam: Hello.'
    );
  });
  it.each([
    '',
    'no time',
    '00:01 --> 00:00\nHello',
    '00:00 --> 00:10\n',
    '0:05 First\n0:02 Second',
  ])('refuses malformed cues', (source) => {
    expect(() => importTranscript(source, 10)).toThrow();
  });
});

describe('transcript cues', () => {
  const track = [
    'WEBVTT',
    '',
    'NOTE not spoken',
    '',
    '00:00:01.250 --> 00:00:03.000',
    '<v.loud Sam de Vries>Along &amp; <b>across</b></v>',
    '',
    'broken --> 00:00:04.000',
    'Skipped',
    '',
    '00:00:03.000 --> 00:00:02.000',
    'Ends before it starts',
    '',
    '01:00:03.004 --> 01:00:05.500',
    '[water]',
    '',
  ].join('\n');

  it('gives each readable line its times in seconds and the voice apart from the words', () => {
    expect(transcriptCues(track)).toEqual([
      { start: 1.25, end: 3, text: 'Along & across', speaker: 'Sam de Vries' },
      { start: 3603.004, end: 3605.5, text: '[water]', speaker: null },
    ]);
  });
  it('keeps the readable text that search indexes unchanged, line for line', () => {
    expect(transcriptText(track)).toEqual(['Sam de Vries: Along & across', '[water]']);
    expect(transcriptCues(track)).toHaveLength(transcriptText(track).length);
    expect(transcriptCues('')).toEqual([]);
  });
});

describe('chapters (MY-305)', () => {
  it('reads one chapter per line, each to the next, the last to the end, and writes them back', () => {
    const track = importChapters('0:00 Opening\n3:10 Wie is <Tim>?\n1:02:03 Slot', 3800);
    expect(chapterList(track)).toEqual([
      { start: 0, end: 190, title: 'Opening' },
      { start: 190, end: 3723, title: 'Wie is <Tim>?' },
      { start: 3723, end: 3800, title: 'Slot' },
    ]);
    expect(chapterLines(track)).toBe('0:00 Opening\n3:10 Wie is <Tim>?\n1:02:03 Slot');
    expect(importChapters(chapterLines(track), 3800)).toBe(track);
  });
  it('clears on empty text and refuses more than the limit', () => {
    expect(importChapters('  \n', 10)).toBe('');
    expect(chapterList('')).toEqual([]);
    const many = Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => `${i}:00 Deel ${i}`).join('\n');
    expect(() => importChapters(many, 100_000)).toThrow('Invalid timed transcript');
  });
});
