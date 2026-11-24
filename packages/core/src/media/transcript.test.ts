import { describe, expect, it } from 'vitest';
import { importTranscript, transcriptText } from './transcript.js';

describe('timed transcript import', () => {
  it('keeps start times, voice names, sound descriptions and escaped text on an edit', () => {
    const track = importTranscript(
      '\uFEFFWEBVTT\r\n\r\na\r\n00:00.100 --> 00:01.110\r\n<v Sam>Along &amp; across\r\n[water]',
      3
    );
    expect(transcriptText(track)).toEqual(['Sam: Along & across\n[water]']);
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
