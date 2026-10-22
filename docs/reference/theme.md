# Theme

What a tenant's theme may contain and how it is checked (TODO #8b2). The decision is [ADR 013](../adr/013-customisation-ladder.md) rule 1: validated values inside bounded ranges, never CSS. Code: `packages/core/src/theme/`. This page is the contract; there is no stored tenant theme yet.

## What exists and what does not

| Delivered in #8b2                                              | Not yet, and where                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ThemeInput` and `Theme` schemas, `checkTheme`, `resolveTheme` | Tenant theme storage, `theme.get` / `theme.update`, the choice interface (#11)                                               |
| `DEFAULT_THEME` and two presets (`editorial`, `campaign`)      | Mapping to CSS custom properties in `apps/web/src/lib/theme`, self-hosted font files with licences and weights (#8c)         |
| The `theme.check` query                                        | A logo and one uploaded wordmark font per tenant, `SiteChrome`, composed blocks and named slots (ADR 013 rules 1, 3, 4; #11) |

Until tenant themes are stored, the renderer applies `DEFAULT_THEME`. The asset route for logos and wordmark fonts must settle type, licence, tenant, storage and deletion rules and a safe SVG strategy first; `media.upload` accepts no SVG or font files today, and a theme has no field for a URL, raw SVG, base64 or a font name.

## Values

| Value           | Range                                           | Default |
| --------------- | ----------------------------------------------- | ------- |
| `baseSize`      | 16 to 22 (px-equivalent; the renderer uses rem) | 18      |
| `scaleRatio`    | 1.125 to 1.5                                    | 1.25    |
| `measure`       | 45 to 85 (ch)                                   | 65      |
| `radius`        | 0 to 24 (px-equivalent)                         | 4       |
| `density`       | 0.8 to 1.3 (factor)                             | 1       |
| `headingWeight` | 400, 500, 600, 700 or 800                       | 700     |
| `fontPair`      | `inter` or `source-serif-inter`                 | `inter` |

`fontPair` is a closed product catalogue: Inter for headings and body, or Source Serif 4 headings with Inter body. A new pair is a product change in this repository (ADR 013 rule 5).

`palettes` holds a complete `light` and a complete `dark` palette. Whoever changes colours sends both, so no unrelated dark default lands on a brand's own light design. Each palette has six role pairs, `body`, `surface`, `primary`, `accent`, `muted` and `warning`, each `{ foreground, background }`, plus `link` and `focus`. Every colour is an opaque `#RRGGBB`: no alpha, names, functions or CSS expressions. Every object is strict, so an unknown key is refused (`theme.key.unknown`).

## Contrast

`checkTheme` reports per mode:

- every role pair: 4.5:1 required; `body` also reports whether it reaches 7:1 (`aaa`), which is not required;
- `link-on-body` and `link-on-surface`: 4.5:1 (the renderer keeps links underlined);
- `focus-on-<role>` for all six role backgrounds: 3:1.

Ratios are WCAG 2.2 relative luminance, compared unrounded; the report rounds to two decimals. Each failing colour gets one issue, its path (`palettes.dark.link`) and `theme.contrast.too-low`.

## Two schemas, one check

- `ThemeInput` is the structure: shape, ranges, closed sets. A colour that is not `#RRGGBB`, a number out of range (also `NaN`, `Infinity` or a string) or an unknown font pair is refused with a catalogue key (`theme.color.invalid`, `theme.value.out-of-range`, `theme.value.not-allowed`). Absent values take the defaults.
- `Theme` is what every later write parses: `ThemeInput`, then `checkTheme`, refusing on any contrast issue, then `resolveTheme` so every default is explicit. A given value is never replaced by a fallback.

`theme.check({ theme: ThemeInput })` is a query (`content:read`, `authenticatedOnly`) that returns `{ valid, pairs, issues }`. A shape error is `invalid_input`; a well-formed theme with poor contrast is a report with `valid: false`, so the editor can show which pair fails while the theme cannot be saved. Messages are catalogue keys with Dutch and English text in `packages/core/src/i18n/`.

## Presets

`DEFAULT_THEME` (Inter, blue and yellow) and `THEME_PRESETS.editorial` (serif headings, warm paper, deep red) and `THEME_PRESETS.campaign` (green and yellow, rounder corners) are complete values and pass `Theme` like a custom theme; `theme.test.ts` checks every one. A preset is a starting point: choosing one and changing a colour is the same path as a theme built from scratch.
