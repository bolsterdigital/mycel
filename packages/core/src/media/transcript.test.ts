import { describe, expect, it } from 'vitest';
import { importTranscript, transcriptCues, transcriptText } from './transcript.js';

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
