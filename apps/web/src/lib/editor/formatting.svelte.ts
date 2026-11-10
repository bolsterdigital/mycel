// What the formatting controls of one writing surface know and do: the state of the text at the
// cursor, and the few commands Mycel offers on it. The fixed bar and the selection bar are two
// views of this one object, so a mark can never be on in one and off in the other.
//
// The set is deliberate (ADR 020 rule 2): strong, emphasis, code and link inside a line; body
// text, three relative headings and two kinds of list around it; undo and redo. No underline
// (it reads as a link), no strikethrough (a correction is a record of its own), no alignment,
// colour, indent buttons or code blocks: none of them has a meaning every renderer, mail and
// export can keep. Rejected: one component holding both bars, which cannot stand in the sticky
// toolbar and next to the selection at once.
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { pendingRangeKey } from './article-extensions.js';

export type InlineMark = 'bold' | 'italic' | 'code';
export type ListKind = 'bulletList' | 'orderedList';
/** 0 is body text; 1 to 3 are the relative heading levels of the stored document. */
export type TextStyle = 0 | 1 | 2 | 3;

export interface FormattingState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: boolean;
  bulletList: boolean;
  orderedList: boolean;
  style: TextStyle;
  /** The deepest heading the place allows: a heading never skips a level (core `RichTextDoc`). */
  deepest: TextStyle;
  /** Words are selected, so a mark or a link has something to apply to. */
  selected: boolean;
  canLink: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface LinkDraft {
  from: number;
  to: number;
  href: string;
  /** The range already is a link: it can be removed, not only changed. */
  existing: boolean;
}

const REST: FormattingState = {
  bold: false,
  italic: false,
  code: false,
  link: false,
  bulletList: false,
  orderedList: false,
  style: 0,
  deepest: 1,
  selected: false,
  canLink: false,
  canUndo: false,
  canRedo: false,
};

export class Formatting {
  editor = $state.raw<Editor | null>(null);
  /** The open link field's range and address, or null while it is closed. */
  link = $state.raw<LinkDraft | null>(null);
  /** Why the last address was refused; empty while there is nothing to say. */
  refusal = $state('');
  #version = $state(0);
  #safe: (href: string) => boolean;
  #refused: () => string;

  constructor(safe: (href: string) => boolean, refused: () => string) {
    this.#safe = safe;
    this.#refused = refused;
  }

  /** Follow one editor; the returned function stops following it. */
  attach(editor: Editor): () => void {
    const changed = () => (this.#version += 1);
    editor.on('transaction', changed);
    editor.on('focus', changed);
    editor.on('blur', changed);
    this.editor = editor;
    return () => {
      editor.off('transaction', changed);
      editor.off('focus', changed);
      editor.off('blur', changed);
      this.editor = null;
    };
  }

  /** Counts every change of the text, the selection and the focus: a view re-reads on it. */
  get version(): number {
    return this.#version;
  }

  get state(): FormattingState {
    void this.#version;
    const editor = this.editor;
    if (!editor) return REST;
    const { selection, doc } = editor.state;
    const level = editor.isActive('heading')
      ? ((editor.getAttributes('heading').level as TextStyle | undefined) ?? 0)
      : 0;
    // The heading before this place decides how deep the next may go. Counted over the whole
    // text: a block that starts after a card continues the outline it interrupted.
    let previous = 0;
    doc.descendants((node, position) => {
      if (position >= selection.from) return false;
      if (node.type.name !== 'heading') return true;
      // The heading the cursor is in is the one being chosen, not the one before it.
      if (position + node.nodeSize <= selection.from) previous = node.attrs.level as number;
      return false;
    });
    const selected = selection instanceof TextSelection && !selection.empty;
    const link = editor.isActive('link');
    return {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      code: editor.isActive('code'),
      link,
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      style: level,
      deepest: Math.max(level, Math.min(3, previous + 1)) as TextStyle,
      selected,
      canLink: selected || link,
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    };
  }

  toggle(mark: InlineMark) {
    const chain = this.editor?.chain().focus();
    if (mark === 'bold') chain?.toggleBold().run();
    else if (mark === 'italic') chain?.toggleItalic().run();
    else chain?.toggleCode().run();
  }

  toggleList(kind: ListKind) {
    const chain = this.editor?.chain().focus();
    if (kind === 'bulletList') chain?.toggleBulletList().run();
    else chain?.toggleOrderedList().run();
  }

  /** Body text or a heading. A heading cannot sit in a list, so the line leaves its list first. */
  setStyle(style: TextStyle) {
    const editor = this.editor;
    if (!editor) return;
    if (style === 0) editor.chain().focus().setParagraph().run();
    else editor.chain().focus().clearNodes().setHeading({ level: style }).run();
  }

  /** `keepFocus` leaves focus on the button, so a keyboard can undo several steps in a row. */
  history(step: 'undo' | 'redo', keepFocus = false) {
    const editor = this.editor;
    if (!editor) return;
    if (step === 'undo') editor.commands.undo();
    else editor.commands.redo();
    if (!keepFocus) editor.commands.focus();
  }

  /** Open the link field for the selected words, or for the whole link the cursor is in. */
  openLink() {
    const editor = this.editor;
    if (!editor) return;
    const existing = editor.isActive('link');
    if (existing && editor.state.selection.empty) editor.commands.extendMarkRange('link');
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const href = existing ? ((editor.getAttributes('link').href as string | null) ?? '') : '';
    editor.view.dispatch(editor.state.tr.setMeta(pendingRangeKey, { from, to }));
    this.refusal = '';
    this.link = { from, to, href, existing };
  }

  /** False when the address is refused: the field stays open and says why. */
  applyLink(value: string): boolean {
    const editor = this.editor;
    const draft = this.link;
    if (!editor || !draft) return false;
    const href = value.trim();
    if (href === '') {
      this.removeLink();
      return true;
    }
    if (!this.#safe(href)) {
      this.refusal = this.#refused();
      return false;
    }
    this.#close();
    this.#back(editor);
    editor
      .chain()
      .focus()
      .setTextSelection({ from: draft.from, to: draft.to })
      .setMark('link', { href, itemId: null })
      .run();
    return true;
  }

  removeLink() {
    const editor = this.editor;
    const draft = this.link;
    if (!editor || !draft) return;
    this.#close();
    this.#back(editor);
    editor
      .chain()
      .focus()
      .setTextSelection({ from: draft.from, to: draft.to })
      .unsetMark('link')
      .run();
  }

  /** Close without a change; the words are selected again, as before the field opened. */
  cancelLink() {
    const editor = this.editor;
    const draft = this.link;
    if (!editor || !draft) return;
    this.#close();
    this.#back(editor);
    editor.chain().focus().setTextSelection({ from: draft.from, to: draft.to }).run();
  }

  /** Close without a change and without taking focus: the writer went somewhere else. */
  closeLink() {
    this.#close();
  }

  // TipTap's `focus` waits for the next frame; a key pressed right after Enter or Escape would
  // go to the field that is closing and be lost. The view takes focus at once.
  #back(editor: Editor) {
    editor.view.focus();
  }

  #close() {
    const editor = this.editor;
    this.link = null;
    this.refusal = '';
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(pendingRangeKey, null));
  }
}

/** Whether this machine's keyboard has a Command key; false on the server. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
}

/** A shortcut as the keyboard prints it, and as `aria-keyshortcuts` spells it. */
export function shortcut(keys: string, mac: boolean): { shown: string; aria: string } {
  const parts = keys.split('+');
  const key = parts.at(-1) ?? '';
  const shift = parts.includes('Shift');
  return {
    shown: mac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`,
    aria: `${mac ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`,
  };
}
