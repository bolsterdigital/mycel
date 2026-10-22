# Fonts

The two font families a theme can choose (`fontPair`, [theme.md](theme.md)), self-hosted under `apps/web/static/fonts/` and served from the site's own origin (ADR 009 rule 4: no external font URL, no npm font package). Each family has its licence next to the files.

| Family         | Version | Source                                                                                                                                                                              | Licence                               | Axes                         |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| Inter          | 4.1     | `https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip` (`InterVariable.ttf`, `InterVariable-Italic.ttf`)                                                              | SIL OFL 1.1, `inter/OFL.txt`          | `wght` 100–900, `opsz` 14–32 |
| Source Serif 4 | 4.005   | `https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip` (`VAR/SourceSerif4Variable-Roman.ttf`, `VAR/SourceSerif4Variable-Italic.ttf`) | SIL OFL 1.1, `source-serif-4/OFL.txt` | `wght` 200–900, `opsz` 8–60  |

Archive checksums (SHA-256): `Inter-4.1.zip` `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`, `source-serif-4.005_Desktop.zip` `549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425`.

## The files

Each variable TTF is subset to Latin and compressed to WOFF2 with fontTools 4.44, all OpenType layout features and both axes kept:

```sh
pyftsubset <font>.ttf --flavor=woff2 --layout-features='*' --output-file=<name>.woff2 \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
```

| File                                               | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `inter/inter-latin-roman.woff2`                    | `83e66d11579a69748d03ee5fe1ef296c45ce7e3da0099460f8c8df3654d5135d` |
| `inter/inter-latin-italic.woff2`                   | `88603583c733f6b897605b8d2ebb97e96b4274b704ad00456cc92c5871d32bc1` |
| `source-serif-4/source-serif-4-latin-roman.woff2`  | `8b7125415273832d17c807d29549998b999d3ff24e51f477d4ffafe3f2288a60` |
| `source-serif-4/source-serif-4-latin-italic.woff2` | `33423e28dec9bd3fc6f2c611d8567a1a3ee685e64078ba8a812e8ffda4c4befc` |

The OFL allows modification and redistribution with the licence text, which sits next to each family. Inter has no Reserved Font Name. Source Serif 4 reserves the name "Source", and the OFL counts a subset as a Modified Version; the subset keeps the original name tables and the CSS calls the family `'Source Serif 4'`. Whether that needs a rename (or Adobe's permission) is an open point for review, recorded in the PR of #8c1; renaming means changing the name tables and the family in `tokens.ts`, nothing else.

## Loading

`themeCss` (`apps/web/src/lib/theme/tokens.ts`) declares `@font-face` with `font-display: swap` and the same Latin `unicode-range`, only for the pair the theme chooses: `inter` never loads Source Serif. The public layout preloads the roman files of the pair. A new family is a product change (ADR 013 rule 5): files, licence, this table and a `FONT_PAIRS` entry together.
