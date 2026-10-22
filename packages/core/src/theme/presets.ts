// The default theme and the presets: starting points that are themselves complete, validated
// values (ADR 013 rule 1), so choosing a preset and then changing one colour is the same path as
// a theme built from scratch. `theme.test.ts` runs every one through `Theme`. Until tenant themes
// are stored (#11), the renderer (#8c) applies DEFAULT_THEME.

import type { ResolvedTheme } from './model.js';

/** Inter throughout, a calm blue and a yellow accent; AAA body text in both modes. */
export const DEFAULT_THEME: ResolvedTheme = {
  version: 1,
  palettes: {
    light: {
      body: { foreground: '#1b1b1f', background: '#ffffff' },
      surface: { foreground: '#1b1b1f', background: '#f3f3f0' },
      primary: { foreground: '#ffffff', background: '#2d6cb5' },
      accent: { foreground: '#1b1b1f', background: '#f2c14e' },
      muted: { foreground: '#55555c', background: '#ffffff' },
      warning: { foreground: '#1b1b1f', background: '#fbe2b4' },
      link: '#1f4f8f',
      focus: '#1b1b1f',
    },
    dark: {
      body: { foreground: '#f2f2f0', background: '#16161a' },
      surface: { foreground: '#f2f2f0', background: '#24242a' },
      primary: { foreground: '#ffffff', background: '#2b62a8' },
      accent: { foreground: '#ffe08a', background: '#3d2e00' },
      muted: { foreground: '#b4b4bb', background: '#16161a' },
      warning: { foreground: '#fbe2b4', background: '#4a3000' },
      link: '#9cc3f5',
      focus: '#ffd479',
    },
  },
  fontPair: 'inter',
  baseSize: 18,
  scaleRatio: 1.25,
  measure: 65,
  radius: 4,
  density: 1,
  headingWeight: 700,
};

export const THEME_PRESETS = {
  /** Serif headings on warm paper, a deep red: for long reads and newsrooms. */
  editorial: {
    version: 1,
    palettes: {
      light: {
        body: { foreground: '#111111', background: '#fdfcf8' },
        surface: { foreground: '#111111', background: '#f1eee6' },
        primary: { foreground: '#ffffff', background: '#b8403a' },
        accent: { foreground: '#111111', background: '#e8d9b0' },
        muted: { foreground: '#5a5650', background: '#fdfcf8' },
        warning: { foreground: '#111111', background: '#f6dcc0' },
        link: '#8a1c1c',
        focus: '#111111',
      },
      dark: {
        body: { foreground: '#eeeae0', background: '#141311' },
        surface: { foreground: '#eeeae0', background: '#22201c' },
        primary: { foreground: '#ffffff', background: '#9e2a2a' },
        accent: { foreground: '#f6e3a8', background: '#3b3000' },
        muted: { foreground: '#b0aa9e', background: '#141311' },
        warning: { foreground: '#f6dcc0', background: '#4d2a0a' },
        link: '#f0a8a0',
        focus: '#f6d36b',
      },
    },
    fontPair: 'source-serif-inter',
    baseSize: 19,
    scaleRatio: 1.333,
    measure: 68,
    radius: 0,
    density: 1.1,
    headingWeight: 600,
  },
  /** Bold green and yellow, larger steps and rounder corners: for campaign pages. */
  campaign: {
    version: 1,
    palettes: {
      light: {
        body: { foreground: '#0f1f17', background: '#ffffff' },
        surface: { foreground: '#0f1f17', background: '#eef6f0' },
        primary: { foreground: '#ffffff', background: '#1d7a46' },
        accent: { foreground: '#0f1f17', background: '#ffd23f' },
        muted: { foreground: '#4b5d53', background: '#ffffff' },
        warning: { foreground: '#0f1f17', background: '#ffe1d6' },
        link: '#14633a',
        focus: '#0f1f17',
      },
      dark: {
        body: { foreground: '#eef6f0', background: '#0e1712' },
        surface: { foreground: '#eef6f0', background: '#1a2620' },
        primary: { foreground: '#ffffff', background: '#1d7a46' },
        accent: { foreground: '#f5d27a', background: '#3a2a00' },
        muted: { foreground: '#a9bcb0', background: '#0e1712' },
        warning: { foreground: '#ffe1d6', background: '#5a1f0c' },
        link: '#8fe0b0',
        focus: '#ffd23f',
      },
    },
    fontPair: 'inter',
    baseSize: 18,
    scaleRatio: 1.414,
    measure: 60,
    radius: 12,
    density: 1,
    headingWeight: 800,
  },
} as const satisfies Record<string, ResolvedTheme>;
