// The formatting bar as the server renders it, before an editor exists: every command has a
// word for its name although it shows a symbol, toggles expose their state, and what cannot act
// yet is disabled instead of silently doing nothing. The behaviour with a text is a browser
// matter (e2e/article-writing.spec.ts).
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import FormatBar from './FormatBar.svelte';
import { Formatting, shortcut } from './formatting.svelte.js';

const bar = (locale: string) =>
  render(FormatBar, {
    props: {
      formatting: new Formatting(
        () => false,
        () => ''
      ),
      locale,
    },
  }).body;

describe('FormatBar', () => {
  it('names every symbol in the language of the admin', () => {
    const out = bar('nl');
    expect(out).toContain('role="toolbar"');
    for (const name of [
      'Vet',
      'Cursief',
      'Code',
      'Link',
      'Opsomming',
      'Genummerde lijst',
      'Ongedaan maken',
      'Opnieuw',
    ])
      expect(out).toContain(`aria-label="${name}"`);
    expect(out).toContain('aria-label="Tekstsoort"');
    expect(bar('en')).toContain('aria-label="Bulleted list"');
  });

  it('exposes toggles as off and disables what has nothing to act on', () => {
    const out = bar('en');
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(6);
    for (const name of ['Link', 'Undo', 'Redo'])
      expect(out).toMatch(new RegExp(`<button[^>]*aria-label="${name}"[^>]*disabled`));
    expect(out).not.toMatch(/<button[^>]*aria-label="Bold"[^>]*disabled/);
  });

  it('has one tab stop among the buttons', () => {
    expect(bar('en').match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('offers body text and three headings, the deeper ones only after a heading', () => {
    const out = bar('en');
    expect(out).toMatch(/<option value="1"[^>]*>Heading<\/option>/);
    expect(out).toMatch(/<option value="2"[^>]*disabled[^>]*>Subheading<\/option>/);
    expect(out).toMatch(/<option value="3"[^>]*disabled[^>]*>Minor heading<\/option>/);
  });
});

describe('shortcut', () => {
  it('prints the keys of the keyboard at hand', () => {
    expect(shortcut('Shift+8', true)).toEqual({ shown: '⇧⌘8', aria: 'Meta+Shift+8' });
    expect(shortcut('B', false)).toEqual({ shown: 'Ctrl+B', aria: 'Control+B' });
  });
});
