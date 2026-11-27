// Keep one editable timed-text representation. Importers normalize timestamps and cue text
// before publication, so the native track and the search projection agree on the spoken words.
import { UseCaseError } from '../errors.js';

const stamp = /^(?:(\d+):)?(\d{1,2}):([0-5]\d)(?:[.,](\d{1,3}))?$/;
const invalid = () => new UseCaseError('invalid_input', 'Invalid timed transcript');
export const MAX_TRANSCRIPT = 200_000;

function parseTime(value: string) {
  const match = stamp.exec(value);
  if (!match || (match[1] && Number(match[2]) > 59)) throw invalid();
  const time =
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 +
    Number((match[4] ?? '').padEnd(3, '0'));
  if (!Number.isSafeInteger(time) || time > 359999999) throw invalid();
  return time;
}

function timestamp(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const pair = (n: number) => String(n).padStart(2, '0');
  return (
    pair(Math.floor(seconds / 3600)) +
    ':' +
    pair(Math.floor(seconds / 60) % 60) +
    ':' +
    pair(seconds % 60) +
    '.' +
    String(ms % 1000).padStart(3, '0')
  );
}

function plain(value: string) {
  return value
    .replace(/<v(?:\.[\w-]+)*\s+([^>]+)>/g, '$1: ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// A VTT comment, stylesheet or region is never spoken text, even when it contains timestamps.
function cueGroups(input: string) {
  return input
    .replace(/^WEBVTT[^\n]*(?:\n|$)/, '')
    .trim()
    .split(/\n[ \t]*\n/)
    .filter((group) => group && !/^(?:NOTE(?:[ \t\n]|$)|(?:STYLE|REGION)(?:\n|$))/.test(group));
}

// A cue that opens with a voice span names its speaker; the rest is what they say.
const voice = /^\s*<v(?:\.[\w-]+)*\s+([^>]+)>/;

function timedCue(group: string) {
  const lines = group.split('\n');
  const index = lines[0]?.includes('-->') ? 0 : 1;
  const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]?.trim() ?? '');
  if (!match) throw invalid();
  const body = lines.slice(index + 1).join('\n');
  const named = voice.exec(body);
  return {
    start: parseTime(match[1]!),
    end: parseTime(match[2]!),
    text: plain(body),
    speaker: (named && plain(named[1]!)) || null,
    spoken: named ? plain(body.slice(named[0].length)) : plain(body),
  };
}

/** The cues a reader sees, in track order; a malformed or empty cue is left out. */
function readableCues(track: string) {
  return cueGroups(track.replace(/\r\n?/g, '\n')).flatMap((group) => {
    // Browsers skip malformed legacy cues. An old track must not take its page out of service.
    try {
      const cue = timedCue(group);
      return cue.end > cue.start && cue.text ? [cue] : [];
    } catch (error) {
      if (error instanceof UseCaseError) return [];
      throw error;
    }
  });
}

/** One line of the readable transcript, the voice's name in its own field. */
export interface TranscriptCue {
  /** Seconds, to the millisecond. */
  start: number;
  end: number;
  /** What is said, without the speaker's name. */
  text: string;
  speaker: string | null;
}

export function transcriptText(track: string) {
  return readableCues(track).map((cue) => cue.text);
}

/**
 * The same lines as `transcriptText`, one per cue, with their times and speaker, for a page
 * that follows the recording (MY-305). Rejected: deriving one from the other, which would let a
 * change to either alter what search indexes.
 */
export function transcriptCues(track: string): TranscriptCue[] {
  return readableCues(track).map((cue) => ({
    start: cue.start / 1000,
    end: cue.end / 1000,
    text: cue.spoken,
    speaker: cue.speaker,
  }));
}

export function importTranscript(source: string, durationSeconds: number | null) {
  if (source.length > MAX_TRANSCRIPT || source.includes('\0')) throw invalid();
  const input = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const timed = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(input) || input.includes('-->');
  const cues: {
    start: number;
    end: number | null;
    text: string;
    speaker?: string | null;
    spoken?: string;
  }[] = timed
    ? cueGroups(input).map(timedCue)
    : input.split('\n').map((line) => {
        const match = /^(\S+)\s+(.+)$/.exec(line.trim());
        if (!match) throw invalid();
        return { start: parseTime(match[1]!), end: null, text: match[2]!.trim() };
      });
  if (!cues.length) throw invalid();
  const result = cues.map((cue, i) => {
    const end =
      cue.end ??
      cues[i + 1]?.start ??
      (durationSeconds === null ? cue.start + 3000 : durationSeconds * 1000);
    if (
      !cue.text ||
      cue.text.includes('-->') ||
      end <= cue.start ||
      (i && cue.start < cues[i - 1]!.start)
    )
      throw invalid();
    const escape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A named voice stays a voice span, so the native track and the read-along keep the speaker;
    // the readable text and search see `Name: ` as before.
    const text =
      cue.speaker && cue.spoken
        ? `<v ${escape(cue.speaker)}>${escape(cue.spoken)}`
        : escape(cue.text);
    return timestamp(cue.start) + ' --> ' + timestamp(end) + '\n' + text;
  });
  const normalized = 'WEBVTT\n\n' + result.join('\n\n') + '\n';
  if (normalized.length > MAX_TRANSCRIPT) throw invalid();
  return normalized;
}
