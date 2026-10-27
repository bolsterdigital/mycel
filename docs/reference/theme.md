# Theme

What a tenant's currently implemented theme may contain and how it is checked (PR #25). [ADR 013](../adr/013-customisation-ladder.md) rule 1 defines validated values inside bounded ranges; the current theme schema stores no CSS. [ADR 022](../adr/022-managed-extensions-and-site-integrations.md) additionally accepts reviewed managed style extensions with visible effective values, but that contract is not implemented by this schema. Code: `packages/core/src/theme/`. Tenant theme and public SiteChrome are stored in `site_settings` (migration 0026), under forced RLS and included in tenant export/import. `site.theme.get/update` and `site.chrome.get/update` are registry use cases, so HTTP, MCP and the server-rendered admin share validation and `content:write` for updates. Each document has its own `baseVersion` compare-and-swap; a stale save fails with a conflict. Public reads need `content:read` and return only public appearance data. The stylesheet route reads the stored theme and the public layout renders localized navigation, footer, legal, support and help links. The content ETag includes chrome so a changed footer cannot keep a stale 304.

The admin route `/admin/[tenant]/site` exposes the bounded colour and font controls and native forms for links and footer in every configured tenant locale. A single-locale site has only one set of locale fields. Native saves preserve stored locale values outside the configured set, reject stale versions, and allow explicit deletion of a translation or optional link. Contrast is computed in the browser for each role pair, while the core `Theme` schema is authoritative on every write. Brand uploads use the same native route: one active logo and one active wordmark font per tenant, with independent version checks and `content:write` on every replacement or removal. The logo accepts at most 2 MiB of SVG or supported raster input and stores only a newly encoded WebP; SVG is restricted to a small drawing vocabulary before decoding. A wordmark font accepts at most 1 MiB of structurally checked WOFF2 with a required licence of at most 500 characters. Its fixed family is used only on the site name. No free asset URL or CSS is stored.

Migration 0027 keeps the two active byte sequences and their metadata in `site_settings` under its forced RLS policy. Tenant export/import and database backup include the bytes and licence with the row; a repeatable-read snapshot or backup already in progress keeps the previous row version when a replacement or removal commits. Tenant deletion cascades to the row. The public `/_brand` route serves only the active safe derivative or font with `nosniff`; the admin preview has an authorized `no-store` route. The asset URL includes its version, the theme hash includes the active font, and the published page ETag includes both brand versions so a revalidation after a change fetches new HTML. Public HTML may remain fresh for its normal one-minute cache window.

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

`fontPair` is currently a closed product catalogue: Inter for headings and body, or Source Serif 4 headings with Inter body. Adding one to this schema is a product change; the managed extension route accepted in ADR 022 has a separate compatibility and effective-style contract.

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

## In CSS (#8c1)

`themeCss(theme)` turns a `ResolvedTheme` into custom properties, and `apps/web/src/lib/theme/base.css` reads nothing else:

| Theme value              | Custom property                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| each role pair           | `--color-<role>-fg`, `--color-<role>-bg` (`body`, `surface`, `primary`, `accent`, `muted`, `warning`)                          |
| `link`, `focus`          | `--color-link`, `--color-focus`                                                                                                |
| `fontPair`               | `--font-body` (Inter in both pairs), `--font-heading` (Inter or Source Serif 4), plus the `@font-face` rules of that pair only |
| `headingWeight`          | `--heading-weight`                                                                                                             |
| `baseSize`, `scaleRatio` | `--step--1` to `--step-4`: `baseSize * scaleRatio^n / 16` in `rem`                                                             |
| `measure`                | `--measure` in `ch`; the page column reads it through a registered `<length>` property, so headings share the text's column    |
| `radius`                 | `--radius` in `rem`                                                                                                            |
| `density`                | `--density`, a factor on the spacing steps                                                                                     |

The light palette sits in `:root`, the dark one under `@media (prefers-color-scheme: dark)`; both are explicit. Colour is only used as a validated pair: a link is coloured only on body and surface (the two backgrounds the check measures it against) and inherits the pair's foreground elsewhere, always underlined.

The stylesheet is a route, `/_theme/<hash>.css`, where the hash is the first 16 hex characters of the SHA-256 of the CSS: `Cache-Control: public, max-age=31536000, immutable`, a malformed hash is a 404, and a former valid hash gets a non-cacheable redirect to the current hash. This keeps HTML still in a shared cache from losing its stylesheet after a theme save without serving different CSS under an immutable URL. The public layout links it and preloads the roman font files of the pair. Not `<style nonce>`: the CSP (`style-src 'self'`, #20c) allows no inline style, components have no nonce, and a stylesheet is cached across pages. `_theme` can never be a page slug (`Slug` starts with `[a-z0-9]`). Focal points and layout choices are classes (`fx-0` to `fx-10`, `layout-wide`, `width-full`, ...), never a `style` attribute. Fonts: [fonts.md](fonts.md).
