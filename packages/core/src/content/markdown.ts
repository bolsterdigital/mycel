// Rich text as a canonical Markdown subset, for the no-JavaScript block forms (brief
// content-editor § B, ADR 020 rule 5): a `textarea` a redacteur can read and type, that turns
// back into the same ProseMirror JSON. The promise is a lossless round trip: for every valid
// `RichTextDoc`, `fromMarkdown(toMarkdown(doc))` is `canonicalRichText(doc)`, which differs from
// the input only where ProseMirror itself does not distinguish (adjacent text with the same
// marks is one text, marks in one fixed order, an empty `content` array is no array, a list
// starting at 1 needs no start). Proven over the registry examples and a seeded fuzz set.
//
// The syntax is Markdown where Markdown is unambiguous, and our own where it is not, because the
// parser is ours and only has to read what the serializer writes plus what a person types:
// - blocks: `##`-`####` for relative heading levels 1-3, `- ` or `1. ` list items indented by
//   the marker's width, one blank line between blocks, a lone `\` for an empty paragraph;
// - marks are toggles, not nesting: `**` bold, `_` italic, `` ` `` code (escapes still apply
//   inside); `[text](url)` or `[text](item:<id>)` a link, `[text][^1]` a footnote whose note is
//   the line `[^1]: note` at the end;
// - a line break is `\` at the end of a line (or `<br>` where no line follows); a single newline
//   is a space, as in Markdown;
// - `\` escapes punctuation, `&#n;` writes any character (control characters, a leading space).
// Rejected: CommonMark through `markdown-it` (its emphasis rules cannot express every mark
// boundary, e.g. bold ending inside a word, so the round trip would lose data) and a HTML
// textarea (hostile to redacteurs, and a second sanitising path).

import { RichTextDoc, type Mark } from './rich-text.js';

type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hard_break' };
type Node = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: Mark[];
};

const MARK_ORDER: Mark['type'][] = ['bold', 'italic', 'code', 'link', 'footnote_reference'];
const TOGGLES: Record<string, Mark['type']> = { '**': 'bold', _: 'italic', '`': 'code' };

const sameMark = (a: Mark, b: Mark) => JSON.stringify(a) === JSON.stringify(b);
const sameMarks = (a: readonly Mark[] = [], b: readonly Mark[] = []) =>
  a.length === b.length && a.every((m, i) => sameMark(m, b[i]!));
const sortMarks = (marks: readonly Mark[]) =>
  [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));

// --- canonical form -----------------------------------------------------------------------------

function canonicalInline(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (n.type === 'hard_break') {
      out.push({ type: 'hard_break' });
      continue;
    }
    const marks = sortMarks(n.marks ?? []);
    const last = out.at(-1);
    if (last?.type === 'text' && sameMarks(last.marks, marks)) last.text += n.text;
    else
      out.push(
        marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text }
      );
  }
  return out;
}

function canonicalNode(node: Node): Node {
  if (node.type === 'paragraph' || node.type === 'heading') {
    const content = canonicalInline((node.content ?? []) as Inline[]);
    return {
      type: node.type,
      ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
      ...(content.length ? { content: content as Node[] } : {}),
    };
  }
  const content = (node.content ?? []).map(canonicalNode);
  if (node.type === 'ordered_list') {
    const start = (node.attrs as { start?: number } | undefined)?.start ?? 1;
    return { type: node.type, ...(start !== 1 ? { attrs: { start } } : {}), content };
  }
  return { type: node.type, content };
}

/** The document as ProseMirror would hold it; equal documents render identically. */
export function canonicalRichText(doc: RichTextDoc): RichTextDoc {
  return { type: 'doc', content: doc.content.map((n) => canonicalNode(n as Node)) } as RichTextDoc;
}

// --- serializer ---------------------------------------------------------------------------------

/** A character the parser reads as syntax wherever it appears in inline text. */
const ALWAYS = /[\\*_`[\]]/;

function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c.charCodeAt(0);
    if (ALWAYS.test(c)) out += `\\${c}`;
    else if (c === '<' && text.startsWith('br>', i + 1)) out += '\\<';
    else if (c === '&' && text[i + 1] === '#') out += '\\&';
    else if (code < 0x20 && c !== '\t') out += `&#${code};`;
    else out += c;
  }
  return out;
}

/** Escapes what would make the start of a line a block marker or indentation. */
function escapeLineStart(line: string): string {
  if (line.startsWith(' ') || line.startsWith('\t'))
    return `&#${line.charCodeAt(0)};${line.slice(1)}`;
  if (line.startsWith('#')) return `\\${line}`;
  if (/^[-*+] /.test(line) || line === '-' || line === '+') return `\\${line}`;
  const ordered = /^(\d+)([.)])( |$)/.exec(line);
  if (ordered) return `${ordered[1]}\\${line.slice(ordered[1]!.length)}`;
  return line;
}

type Span = Extract<Mark, { type: 'link' | 'footnote_reference' }>;
const isSpan = (m: Mark): m is Span => m.type === 'link' || m.type === 'footnote_reference';

/** Inline nodes as text lines (a hard break followed by more starts a new line). */
function serializeInline(nodes: readonly Inline[], notes: string[]): string[] {
  const lines: string[] = [''];
  let atLineStart = true;
  let toggles = new Set<Mark['type']>();
  const stack: Span[] = [];
  const emit = (s: string) => {
    lines[lines.length - 1] += s;
  };
  const closeSpan = () => {
    const span = stack.pop()!;
    if (span.type === 'link') {
      const target =
        span.attrs.itemId !== undefined ? `item:${span.attrs.itemId}` : span.attrs.href!;
      emit(`](${target.replace(/[\\)]/g, '\\$&')})`);
    } else {
      notes.push(span.attrs.text);
      emit(`][^${notes.length}]`);
    }
  };
  const setToggles = (want: Set<Mark['type']>) => {
    for (const [token, type] of Object.entries(TOGGLES))
      if (toggles.has(type) !== want.has(type)) emit(token);
    toggles = want;
  };
  nodes.forEach((n, i) => {
    if (n.type === 'hard_break') {
      const more = i < nodes.length - 1;
      if (more) {
        emit('\\');
        lines.push('');
        atLineStart = true;
      } else emit('<br>');
      return;
    }
    const marks = n.marks ?? [];
    const spans = marks.filter(isSpan);
    // Close spans down to the longest prefix of the stack this node still has.
    let keep = 0;
    while (keep < stack.length && keep < spans.length && sameMark(stack[keep]!, spans[keep]!))
      keep++;
    // A span that continues but sits above one that ends is closed and reopened.
    const wanted = spans.filter((s) => !stack.slice(0, keep).some((k) => sameMark(k, s)));
    if (stack.length > keep) {
      // Toggles are state, not nesting: close spans without touching them.
      while (stack.length > keep) closeSpan();
    }
    for (const s of wanted) {
      emit('[');
      stack.push(s);
    }
    setToggles(new Set(marks.filter((m) => !isSpan(m)).map((m) => m.type)));
    let text = escapeText(n.text);
    if (atLineStart && lines.at(-1) === '') text = escapeLineStart(text);
    atLineStart = false;
    emit(text);
  });
  setToggles(new Set());
  while (stack.length) closeSpan();
  return lines;
}

/** Each line of a paragraph or heading, with the line-start escapes applied after a break. */
function inlineLines(nodes: readonly Inline[] | undefined, notes: string[]): string[] {
  return serializeInline(nodes ?? [], notes);
}

function serializeBlocks(nodes: readonly Node[], notes: string[], inItem = false): string[] {
  const out: string[] = [];
  let previousMarker = '';
  nodes.forEach((node, i) => {
    const separator = i === 0 ? [] : inItem && node.type !== 'paragraph' ? [] : [''];
    if (node.type === 'paragraph') {
      const lines = inlineLines(node.content as Inline[] | undefined, notes);
      out.push(...separator, ...(lines.length === 1 && lines[0] === '' ? ['\\'] : lines));
      previousMarker = '';
    } else if (node.type === 'heading') {
      const level = (node.attrs as { level: number }).level;
      const hashes = '#'.repeat(level + 1);
      const [first = '', ...rest] = inlineLines(node.content as Inline[] | undefined, notes);
      out.push(...separator, first ? `${hashes} ${first}` : hashes, ...rest);
      previousMarker = '';
    } else {
      const ordered = node.type === 'ordered_list';
      // Two lists of one kind in a row stay two lists: the second uses the other marker.
      const kind = ordered ? ['.', ')'] : ['-', '*'];
      const marker = previousMarker === kind[0] ? kind[1]! : kind[0]!;
      previousMarker = marker;
      const start = (node.attrs as { start?: number } | undefined)?.start ?? 1;
      out.push(...separator);
      (node.content ?? []).forEach((item, n) => {
        const bullet = ordered ? `${start + n}${marker} ` : `${marker} `;
        const pad = ' '.repeat(bullet.length);
        const lines = serializeBlocks(item.content ?? [], notes, true);
        lines.forEach((line, k) => out.push(k === 0 ? bullet + line : line ? pad + line : ''));
      });
    }
  });
  return out;
}

/** The document as Markdown; footnote notes follow at the end, numbered in order. */
export function toMarkdown(doc: RichTextDoc): string {
  const notes: string[] = [];
  const body = serializeBlocks(canonicalRichText(doc).content as Node[], notes);
  const defs = notes.map((note, i) => `[^${i + 1}]: ${escapeNote(note)}`);
  return [...body, ...(defs.length ? ['', ...defs] : [])].join('\n');
}

/** A note on one line: backslashes, `&#` and control characters escaped, a leading space kept. */
function escapeNote(note: string): string {
  let out = '';
  for (let i = 0; i < note.length; i++) {
    const c = note[i]!;
    const code = c.charCodeAt(0);
    if (c === '\\') out += '\\\\';
    else if (c === '&' && note[i + 1] === '#') out += '\\&';
    else if ((code < 0x20 && c !== '\t') || (i === 0 && c === ' ')) out += `&#${code};`;
    else out += c;
  }
  return out;
}

// --- parser -------------------------------------------------------------------------------------

/** Why a text could not be read, with the 1-based line, for the form's error message. */
export interface MarkdownError {
  line: number;
  message:
    | 'editor.markdown.unclosed-link'
    | 'editor.markdown.unknown-footnote'
    | 'editor.markdown.list-item-start'
    | 'editor.markdown.invalid';
}

export type MarkdownResult = { ok: true; doc: RichTextDoc } | { ok: false; error: MarkdownError };

class ParseError extends Error {
  constructor(readonly detail: MarkdownError) {
    super(detail.message);
  }
}

interface Line {
  text: string;
  /** 1-based line number in the textarea. */
  no: number;
}

const LIST = /^(?:([-*]) |(\d{1,6})([.)]) )/;
const LIST_BARE = /^(?:([-*])|(\d{1,6})([.)]))$/;
const HEADING = /^(#{2,4})(?: (.*))?$/;

function listMarker(text: string): { kind: string; start: number; width: number } | null {
  const m = LIST.exec(text) ?? LIST_BARE.exec(text);
  if (!m) return null;
  if (m[1]) return { kind: m[1], start: 1, width: 2 };
  return { kind: m[3]!, start: Number(m[2]), width: m[2]!.length + 2 };
}

/** Reads the inline syntax of one paragraph or heading (its lines joined by `\n`). */
function parseInline(source: string, firstLine: number, notes: Map<string, string>): Inline[] {
  const nodes: Inline[] = [];
  const state = new Set<Mark['type']>();
  const open: { at: number; line: number; state: Mark['type'][] }[] = [];
  let text = '';
  let line = firstLine;
  const marks = (): Mark[] =>
    MARK_ORDER.filter((t) => state.has(t)).map((type) => ({ type }) as Mark);
  const flush = () => {
    if (!text) return;
    const m = marks();
    nodes.push(m.length ? { type: 'text', text, marks: m } : { type: 'text', text });
    text = '';
  };
  const addMark = (from: number, mark: Mark) => {
    for (let k = from; k < nodes.length; k++) {
      const n = nodes[k]!;
      if (n.type === 'text') n.marks = [...(n.marks ?? []), mark];
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const rest = source.slice(i);
    if (c === '\\' && source[i + 1] === '\n') {
      flush();
      nodes.push({ type: 'hard_break' });
      i += 2;
      line++;
    } else if (rest.startsWith('<br>')) {
      flush();
      nodes.push({ type: 'hard_break' });
      i += 4;
    } else if (c === '\\' && i + 1 < source.length) {
      text += source[i + 1];
      i += 2;
    } else if (c === '&' && /^&#\d{1,7};/.test(rest)) {
      const entity = /^&#(\d{1,7});/.exec(rest)!;
      text += String.fromCodePoint(Math.min(Number(entity[1]), 0x10ffff));
      i += entity[0].length;
    } else if (rest.startsWith('**') || c === '_' || c === '`') {
      const token = rest.startsWith('**') ? '**' : c;
      flush();
      const type = TOGGLES[token]!;
      if (state.has(type)) state.delete(type);
      else state.add(type);
      i += token.length;
    } else if (c === '[') {
      flush();
      open.push({ at: nodes.length, line, state: [...state] });
      i += 1;
    } else if (c === ']' && open.length && (source[i + 1] === '(' || rest.startsWith('][^'))) {
      flush();
      const span = open.pop()!;
      if (source[i + 1] === '(') {
        let target = '';
        let j = i + 2;
        while (j < source.length && source[j] !== ')') {
          if (source[j] === '\\' && j + 1 < source.length) j++;
          target += source[j];
          j++;
        }
        if (j >= source.length)
          throw new ParseError({ line, message: 'editor.markdown.unclosed-link' });
        const attrs = target.startsWith('item:')
          ? { itemId: target.slice('item:'.length) }
          : { href: target };
        addMark(span.at, { type: 'link', attrs } as Mark);
        i = j + 1;
      } else {
        const end = source.indexOf(']', i + 3);
        const id = end < 0 ? '' : source.slice(i + 3, end);
        const note = notes.get(id);
        if (note === undefined)
          throw new ParseError({ line, message: 'editor.markdown.unknown-footnote' });
        addMark(span.at, { type: 'footnote_reference', attrs: { text: note } });
        i = end + 1;
      }
    } else if (c === '\n') {
      // A single newline is a space, as in Markdown.
      text += ' ';
      i += 1;
      line++;
    } else {
      text += c;
      i += 1;
    }
  }
  flush();
  // A `[` that never closed was text: put it back where it stood.
  for (const span of open.reverse()) {
    const m = MARK_ORDER.filter((t) => span.state.includes(t)).map((type) => ({ type }) as Mark);
    nodes.splice(
      span.at,
      0,
      m.length ? { type: 'text', text: '[', marks: m } : { type: 'text', text: '[' }
    );
  }
  return nodes;
}

/** Splits off the footnote definitions (`[^id]: note` lines at the start of a line). */
function extractNotes(lines: Line[]): { body: Line[]; notes: Map<string, string> } {
  const notes = new Map<string, string>();
  const body: Line[] = [];
  for (const l of lines) {
    // An id is letters, digits, `-` or `_`; a span over text that starts with `^` never reads
    // as one, because the text's `]` and backslashes are escaped.
    const def = /^\[\^([\w-]+)\]: ?(.*)$/.exec(l.text);
    if (def) notes.set(def[1]!, unescapeNote(def[2]!));
    else body.push(l);
  }
  return { body, notes };
}

function unescapeNote(s: string): string {
  return s.replace(/\\(.)|&#(\d{1,7});/g, (_, escaped: string | undefined, code: string) =>
    escaped !== undefined ? escaped : String.fromCodePoint(Math.min(Number(code), 0x10ffff))
  );
}

/** True when the line ends in an unescaped backslash: a line break. */
const endsWithBreak = (t: string) => (/\\+$/.exec(t)?.[0].length ?? 0) % 2 === 1;

/** Lines that belong to a paragraph or heading: up to a blank line or a block marker. */
function takeParagraph(lines: Line[], from: number, heading: boolean): number {
  let end = from + 1;
  while (end < lines.length) {
    const t = lines[end]!.text;
    if (t === '') break;
    // A heading only continues after a line break; a paragraph ends where a block starts.
    if (heading && !endsWithBreak(lines[end - 1]!.text)) break;
    if (!heading && (HEADING.test(t) || listMarker(t))) break;
    end++;
  }
  return end;
}

function parseBlocks(lines: Line[], notes: Map<string, string>): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text, no } = lines[i]!;
    if (text === '') {
      i++;
      continue;
    }
    const marker = listMarker(text);
    if (marker) {
      const items: Node[] = [];
      let start = marker.start;
      let first = true;
      while (i < lines.length) {
        const m = listMarker(lines[i]!.text);
        if (!m || m.kind !== marker.kind) break;
        if (first) start = m.start;
        first = false;
        // The item: its first line after the marker, then every line indented by the marker's
        // width, and blank lines that are followed by such a line.
        const itemLines: Line[] = [{ text: lines[i]!.text.slice(m.width), no: lines[i]!.no }];
        let j = i + 1;
        while (j < lines.length) {
          const t = lines[j]!.text;
          const indented = t.startsWith(' '.repeat(m.width));
          if (indented) {
            itemLines.push({ text: t.slice(m.width), no: lines[j]!.no });
            j++;
          } else if (t === '') {
            let k = j;
            while (k < lines.length && lines[k]!.text === '') k++;
            if (k < lines.length && lines[k]!.text.startsWith(' '.repeat(m.width))) {
              for (; j < k; j++) itemLines.push({ text: '', no: lines[j]!.no });
            } else break;
          } else if (listMarker(t) || t === '') break;
          else break;
        }
        const content = parseBlocks(itemLines, notes);
        if (content[0]?.type !== 'paragraph')
          throw new ParseError({ line: lines[i]!.no, message: 'editor.markdown.list-item-start' });
        items.push({ type: 'list_item', content });
        i = j;
        // Items may be separated by blank lines.
        let k = i;
        while (k < lines.length && lines[k]!.text === '') k++;
        const next = k < lines.length ? listMarker(lines[k]!.text) : null;
        if (next && next.kind === marker.kind && k > i) i = k;
      }
      const ordered = marker.kind === '.' || marker.kind === ')';
      out.push(
        ordered
          ? { type: 'ordered_list', ...(start !== 1 ? { attrs: { start } } : {}), content: items }
          : { type: 'bullet_list', content: items }
      );
      continue;
    }
    const heading = HEADING.exec(text);
    const end = takeParagraph(lines, i, heading !== null);
    if (!heading && end === i + 1 && text === '\\') {
      out.push({ type: 'paragraph' });
      i = end;
      continue;
    }
    const source = [
      heading ? (heading[2] ?? '') : text,
      ...lines.slice(i + 1, end).map((l) => l.text),
    ].join('\n');
    const content = parseInline(source, no, notes);
    const node: Node = heading
      ? { type: 'heading', attrs: { level: heading[1]!.length - 1 } }
      : { type: 'paragraph' };
    if (content.length) node.content = content as Node[];
    out.push(node);
    i = end;
  }
  return out;
}

/** Reads a textarea back into a document, validated by the core schema. */
export function fromMarkdown(markdown: string): MarkdownResult {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text, n) => ({ text: text.trimEnd() === '' ? '' : text, no: n + 1 }));
  try {
    const { body, notes } = extractNotes(lines);
    const doc = canonicalRichText({
      type: 'doc',
      content: parseBlocks(body, notes),
    } as RichTextDoc);
    const parsed = RichTextDoc.safeParse(doc);
    if (!parsed.success)
      return { ok: false, error: { line: 1, message: 'editor.markdown.invalid' } };
    return { ok: true, doc };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.detail };
    throw e;
  }
}
