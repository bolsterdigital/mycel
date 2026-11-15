// The caption face is the one theme value that adds a property only when chosen: `body` must keep
// every existing stylesheet byte-identical (and so its hash and URL), `mono` adds exactly one line.
// Rejected: asserting through the block conformance grammar alone, which never renders a mono
// theme because no preset chooses one.
import { DEFAULT_THEME, THEME_PRESETS, type ResolvedTheme } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { CAPTION_MONO, themeCss, themeHash } from './tokens.js';

const themes: ResolvedTheme[] = [DEFAULT_THEME, ...Object.values(THEME_PRESETS)];

describe('caption font tokens', () => {
  it('sets no caption face for body, nor for a theme stored before the choice', async () => {
    for (const theme of themes) {
      const body = themeCss({ ...theme, captionFont: 'body' });
      const { captionFont: _, ...stored } = theme;
      const before = themeCss(stored as ResolvedTheme);
      expect(body).not.toContain('--font-caption');
      expect(body).toBe(before);
      expect(await themeHash(body)).toBe(await themeHash(before));
    }
  });

  it('sets the system monospace once, in :root and not per colour scheme, for mono', () => {
    for (const theme of themes) {
      const body = themeCss(theme);
      const mono = themeCss({ ...theme, captionFont: 'mono' });
      const line = `--font-caption: ${CAPTION_MONO};`;
      expect(mono.split(line)).toHaveLength(2);
      expect(mono.indexOf(line)).toBeLessThan(mono.indexOf('@media (prefers-color-scheme: dark)'));
      expect(mono.replace(`  ${line}\n`, '')).toBe(body);
      expect(CAPTION_MONO).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
    }
  });
});
