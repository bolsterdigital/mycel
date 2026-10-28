// `site.theme.check` (ADR 013 consequences): the contrast report an editor shows live and an agent
// calls before proposing colours. A query without storage: there is no theme write, table or
// capability yet (#11 adds them and parses with `Theme`, the same check). A shape error (a colour
// that is not `#RRGGBB`, a size out of range) is `invalid_input`; a well-formed theme whose
// contrast fails is a report with `valid: false`, so the editor can explain it.

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { ThemeReport, checkTheme } from './check.js';
import { ThemeInput } from './model.js';
import { DEFAULT_THEME } from './presets.js';

export const checkThemeUseCase = defineUseCase({
  name: 'site.theme.check',
  kind: 'query',
  description:
    'Check the contrast of a theme in light and dark mode; reports every colour pair and which ones fail, without storing anything.',
  requires: 'content:read',
  authenticatedOnly: true,
  input: z.object({ theme: ThemeInput }).strict(),
  output: ThemeReport,
  examples: [
    { input: { theme: DEFAULT_THEME }, note: 'The default theme: every pair passes.' },
    {
      input: {
        theme: {
          palettes: {
            light: {
              ...DEFAULT_THEME.palettes.light,
              primary: { foreground: '#ffffff', background: '#f2c14e' },
            },
            dark: DEFAULT_THEME.palettes.dark,
          },
        },
      },
      note: 'White on yellow: valid is false and the issue names palettes.light.primary.',
    },
    { input: { theme: { fontPair: 'source-serif-inter', baseSize: 20 } } },
  ],
  handler: async (_ctx, { theme }) => checkTheme(theme),
});
