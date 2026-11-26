# Fonts

The font catalogue a theme chooses its heading and body font from (`headingFont`, `bodyFont`, [theme.md](theme.md); `packages/core/src/theme/fonts.ts`), self-hosted under `apps/web/static/fonts/` and served from the site's own origin (ADR 009 rule 4: no external font URL, no npm font package). Each family has its licence next to the files.

| Family         | Version | Source                                                                                                                                                                              | Licence                               | Axes                                                                          |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Inter          | 4.1     | `https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip` (`InterVariable.ttf`, `InterVariable-Italic.ttf`)                                                              | SIL OFL 1.1, `inter/OFL.txt`          | roman `wght` 100–900, `opsz` 14–32; italic `wght` 400–700, `opsz` fixed at 14 |
| Source Serif 4 | 4.005   | `https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip` (`VAR/SourceSerif4Variable-Roman.ttf`, `VAR/SourceSerif4Variable-Italic.ttf`) | SIL OFL 1.1, `source-serif-4/OFL.txt` | `wght` 200–900, `opsz` 8–60                                                   |

Archive checksums (SHA-256): `Inter-4.1.zip` `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`, `source-serif-4.005_Desktop.zip` `549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425`.

## The files

Each variable TTF is subset to Latin and compressed to WOFF2 with fontTools 4.44, all OpenType layout features and both axes kept, except the Inter italic (below):

```sh
pyftsubset <font>.ttf --flavor=woff2 --layout-features='*' --output-file=<name>.woff2 \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
```

The Inter italic is first instanced to `wght` 400–700 with `opsz` fixed at its text size, which halves it (116 KB to 53 KB): italic only appears in running text (`em`, `cite`), between regular and bold, and on a page that uses it the file sits on the mobile LCP path. Headings and pull quotes are plain text and never italic.

```sh
# The instancer stamps head.modified with the current time; a fixed epoch makes the output byte-identical.
export SOURCE_DATE_EPOCH=1793463045
fonttools varLib.instancer InterVariable-Italic.ttf wght=400:700 opsz=14 -o InterItalic-text.ttf
pyftsubset InterItalic-text.ttf ...   # same arguments as above
```

| File                                               | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `gabarito/gabarito-latin-roman.woff2`              | `2de44d9498fb3ea0d006bc17a50eaca72d14bc2dad6dfa70d3a12a4da41a8216` |
| `inter/inter-latin-italic.woff2`                   | `81764e52069ea0efbd520ba568be50bf95bf472615c232ed8cba5d8a429feac7` |
| `inter/inter-latin-roman.woff2`                    | `83e66d11579a69748d03ee5fe1ef296c45ce7e3da0099460f8c8df3654d5135d` |
| `open-sans/open-sans-latin-italic.woff2`           | `e3b527d0dc7f56ffceb453c641dee8d1c3daae1a406100ff67bbf268808b35ec` |
| `open-sans/open-sans-latin-roman.woff2`            | `4f75d5000b5f2ef23bc2e90ccc1bda2177989202386d6a43f661297b7d810b83` |
| `poppins/poppins-latin-400-italic.woff2`           | `9be545181cc0ff8a277c43a946f82e8caa2d20b90d1859ef526ada24c59ee95d` |
| `poppins/poppins-latin-400.woff2`                  | `4c571ae2fc740778b7546263e0c81256c8304462cadf6b74e368069831adea7e` |
| `poppins/poppins-latin-500.woff2`                  | `a80106f01ad0a25225674f55c3b1a68bea290477a8586c9839daf1084c651ba5` |
| `poppins/poppins-latin-600.woff2`                  | `0c54e3ef02c1bd0d8c7e26b8ae6ae9685aef00c93b0e602fac5c0d676b6bf402` |
| `poppins/poppins-latin-700-italic.woff2`           | `7e084dbf2b15173c4966144e2f1619a92516de5fc9e36790b3f67a829c136d1c` |
| `poppins/poppins-latin-700.woff2`                  | `d677216dfda0eca39c355153c695b2e539fda91813f977a8b320c0fd3b4267da` |
| `poppins/poppins-latin-800.woff2`                  | `b81ec98fb8d641d99666e14b83ed6f5be1e6e96d279516668fed41bfd40de084` |
| `quicksand/quicksand-roman.woff2`                  | `97934c427173c67ff8b5c8100e4d0a54c26730e11c2008db4c1f7276c28d16f5` |
| `raleway/raleway-italic.woff2`                     | `cc2007885050965677acc3958552c9e4379822910dfe2bb289071d83806fe59b` |
| `raleway/raleway-roman.woff2`                      | `ded82018ec8a2b198447d2103d1d8e28137b1cdeb60187a8a58ae98d5ceed676` |
| `roboto/roboto-latin-italic.woff2`                 | `85e79462bb13dd2329c0a2a14e5b6b29759095646311d458b72c4b2bbe7e0fdb` |
| `roboto/roboto-latin-roman.woff2`                  | `c15857870f32e899381ec68e04d8010e0457aa763fa3ea206d17da2c36b5959e` |
| `rubik/rubik-latin-italic.woff2`                   | `90fa45ee6bb2fed08514c516e956cb1d52228ab2b392ce7246537220b8916acb` |
| `rubik/rubik-latin-roman.woff2`                    | `68ac376768076fc1ca0d7cee377afb3c0256984fd3a64c227360b13e6d4afc37` |
| `source-sans-3/source-sans-3-italic.woff2`         | `85f6615883e7f7ab12072f67e41f1c0c2d2a301aecb301c22d0fe2a0935c84b2` |
| `source-sans-3/source-sans-3-roman.woff2`          | `768d1f7fb0a0a113a76191eaf0385119bfc9bd8e825d72786a5a3a469d7c0dbd` |
| `source-serif-4/source-serif-4-latin-italic.woff2` | `d73d43f16a6bd38e4d4216da5b3c62e084796c9f74b6ed1c822bc36b43fe0cf7` |
| `source-serif-4/source-serif-4-latin-roman.woff2`  | `881e4bcb9da9a53cfd00100c0737438165fa17083a5aec3072f502e0f3a2f802` |
| `vesper-libre/vesper-libre-latin-400.woff2`        | `e924f5e3c1e3f603f7a34de4c3851a528153daf975cffc5e77c5b9aa1941ceeb` |
| `vesper-libre/vesper-libre-latin-500.woff2`        | `e8faa171476a1bbdbac70085d39367a5139003a364807e203addd4081fca97f4` |
| `vesper-libre/vesper-libre-latin-700.woff2`        | `2d98921561523ac0db6ca8e852238ddfbb745fc74438126cc101a291816534cb` |
| `work-sans/work-sans-latin-italic.woff2`           | `4dbc43c778cecd609fee30fcf4e1ec815cc9184fa7b920ef4156596e5e047310` |
| `work-sans/work-sans-latin-roman.woff2`            | `03c6d96cfd1597ea4aa8822270b17098a804b0c7e7eb0e57771cb292c10a887b` |
| `zilla-slab/zilla-slab-latin-400-italic.woff2`     | `7c6a41e91935cbf0276fe3691a19850185f15f532a8d6b29b48c42fc97fbdab0` |
| `zilla-slab/zilla-slab-latin-400.woff2`            | `a3daf6808bc0f329143e998009ff90e5fdf84cbdcb2be7908e05498d7a1c5835` |
| `zilla-slab/zilla-slab-latin-500.woff2`            | `d65251f307e3be004aa47e055086ce84a638b42131e00513477a40de4f171cf3` |
| `zilla-slab/zilla-slab-latin-600.woff2`            | `4f62a2fa2f313ee6cdddf0fa677a4df1f2dca08e80d3696ff439f6b25c8e6550` |
| `zilla-slab/zilla-slab-latin-700-italic.woff2`     | `c0780ac3ae2f0eaaf37af38e86252729fe6983237c481718fd3bc1191220eed4` |
| `zilla-slab/zilla-slab-latin-700.woff2`            | `75aaf0e6843267ace04b6003071b020bb7b7f75de9698c74ead43820aed9bf10` |

The OFL allows modification and redistribution with the licence text, which sits next to each family. Inter has no Reserved Font Name. Source Serif 4 reserves the name "Source", and the OFL counts a subset as a Modified Version, so the subset is renamed **Mycel Serif**: after `pyftsubset`, every `name` record except the copyright (0) and trademark (7) notices has `Source Serif 4` replaced by `Mycel Serif` and `SourceSerif4` by `MycelSerif` (fontTools, decided 2026-10-22 in the review of #8c1). The CSS family is `'Mycel Serif'`; the directory and file names keep the origin, which the OFL allows.

## The catalogue families (MY-261)

The eleven families beside Inter and Source Serif are the ones the Dreamkit sites use (`wings-tokens*.json` of each client repository, 2026-11-19). Their sources are the `ofl/` directories of [google/fonts](https://github.com/google/fonts) at commit `cc5661d43cd4f9aad5567033a8e15ca28dc35c86`; each directory's `OFL.txt` sits next to the files. Every family is SIL OFL 1.1.

| Key             | Family        | Source files (`ofl/<dir>/`)                                                      | Shape                                      | Weights                                  |
| --------------- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `open-sans`     | Open Sans     | `opensans/OpenSans[wdth,wght].ttf`, `-Italic`                                    | variable, `wdth` pinned at 100             | 300–800                                  |
| `rubik`         | Rubik         | `rubik/Rubik[wght].ttf`, `-Italic`                                               | variable                                   | 300–900                                  |
| `roboto`        | Roboto        | `roboto/Roboto[wdth,wght].ttf`, `-Italic`                                        | variable, `wdth` pinned at 100             | 100–900                                  |
| `work-sans`     | Work Sans     | `worksans/WorkSans[wght].ttf`, `-Italic`                                         | variable                                   | 100–900                                  |
| `gabarito`      | Gabarito      | `gabarito/Gabarito[wght].ttf`                                                    | variable, no italic                        | 400–900                                  |
| `poppins`       | Poppins       | `poppins/Poppins-{Regular,Medium,SemiBold,Bold,ExtraBold,Italic,BoldItalic}.ttf` | static                                     | 400, 500, 600, 700, 800; italic 400, 700 |
| `zilla-slab`    | Zilla Slab    | `zillaslab/ZillaSlab-{Regular,Medium,SemiBold,Bold,Italic,BoldItalic}.ttf`       | static                                     | 400, 500, 600, 700; italic 400, 700      |
| `vesper-libre`  | Vesper Libre  | `vesperlibre/VesperLibre-{Regular,Medium,Bold}.ttf`                              | static, no italic                          | 400, 500, 700                            |
| `raleway`       | Raleway       | `raleway/Raleway[wght].ttf`, `-Italic`                                           | unmodified (Reserved Font Name)            | 100–900                                  |
| `quicksand`     | Quicksand     | `quicksand/Quicksand[wght].ttf`                                                  | unmodified (Reserved Font Name), no italic | 300–700                                  |
| `source-sans-3` | Source Sans 3 | `sourcesans3/SourceSans3[wght].ttf`, `-Italic`                                   | unmodified (Reserved Font Name)            | 200–900                                  |

Three shapes, with `SOURCE_DATE_EPOCH=1793463045` as above:

- **Variable**: `fonttools varLib.instancer <font> wdth=100` where a width axis exists, then `pyftsubset` with the arguments above, to `<key>/<key>-latin-roman.woff2` and `-latin-italic.woff2`.
- **Static**: `pyftsubset` per file to `<key>/<key>-latin-<weight>.woff2` and `-latin-<weight>-italic.woff2`.
- **Reserved Font Name** (Raleway, Quicksand, Source Sans 3): a subset is a Modified Version and could not keep its name, and a renamed Raleway is not the font a site asks for. These are the upstream fonts compressed to WOFF2 and otherwise unchanged (`TTFont(src); flavor = 'woff2'; save()`), which the OFL-FAQ (2.2) allows under the original name. They carry every script of the font, so their `@font-face` has no `unicode-range`, and they are larger (up to 170 KB).

Every family has a regular (400) and a bold (700), so each can set body text; `hasWeight` refuses a heading weight a static family has no file for (`theme.font.weight-unavailable`). A family without an italic gets the browser's slanted roman.

## The share card

`packages/media-sharp/fonts/<key>/card.woff2` is the heading font of the share card (`share-card.ts`), one file per catalogue key: a static instance at weight 400 (every other axis at its default), Latin subset, with the family renamed **Mycel Card** in every `name` record except copyright and trademark. Static, because satori draws a variable font at its default instance, which for Raleway is Thin; renamed, because an instance is a Modified Version and three families reserve their name. The recipe is `instancer.instantiateVariableFont(font, { wght: 400, <other axes>: None })`, then the subset above. Inter and Mycel Serif are made from their files in this directory's history (the full variable fonts). Each file's licence sits beside it as `OFL.txt`.

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `gabarito.woff2`           | `0e8a552a236dc7deaea81b9e35d8d75695f30b0274b3197398ec0d010990929e` |
| `inter.woff2`              | `389083befcdcd32a750182de00b6e17774e107c30cb8b8ff640ea7bbc3f88e2d` |
| `mycel-serif.woff2`        | `e371d12b6c0f5eb130f6ee4f12acb9e2f9474bac6c000b15884ef61e14b076bf` |
| `open-sans.woff2`          | `b646426ad92f39a4fd1c155fba5e77192206b7d7faeca01511b726eac5ef50a5` |
| `poppins.woff2`            | `b0712787a3a5145779a41f525c57dbe7e0b35deb2c4c825d8874be0299a89c27` |
| `quicksand.woff2`          | `e69bac9d395aa5f83c4b3463627d6f53370d50728ff0aabe76fd4e5a64c9062c` |
| `raleway.woff2`            | `af9b741acc722db447590af2a16ff753d060451313e71ba0eace0f7dfe9411e3` |
| `roboto.woff2`             | `30e8079af7538827a82313850394ce06585c2d76100849a1e8c4a0dece4c8e94` |
| `rubik.woff2`              | `289e3d8d74f0e1e9e1100ab52d751efb3f3db8d9839badd6b2ed712998bfb932` |
| `source-sans-3/card.woff2` | `96c1c0ff2b69ae5357c58f2e9b2fbd1250ff8262334fa879803fcca41ab1690a` |
| `vesper-libre.woff2`       | `20313456ee9031c20b7a027c98fc262c891764d4662efd0e09853dcf776b65f2` |
| `work-sans.woff2`          | `59a32efd40bed9429bcd33abceb39c2c0d7f1c97630cafeba82b8411c3efec36` |
| `zilla-slab.woff2`         | `5c9c5b6a63dc8f883de2045c8606ce7247bab0e3cab61880307d0b5834686a17` |

## Loading

`themeCss` (`apps/web/src/lib/theme/tokens.ts`) declares `@font-face` with `font-display: swap` and the same Latin `unicode-range`, only for the two families the theme chooses (`apps/web/src/lib/theme/font-files.ts`); the unmodified Reserved Font Name families have no `unicode-range`. The public layout preloads the body's regular file first, then the heading's file at its weight (one file when they are the same). A rendered page whose body has an element that is italic by default (`em`, `i`, `cite`, `dfn`, `var`, `address`) also preloads the body font's italic, at low priority (`withItalicPreload`, applied in the server hook): discovered during layout it would be fetched at the highest priority, which Lighthouse counts as render-blocking although `font-display: swap` paints text before it arrives. Pages without italic text never fetch it. A body font without an italic adds nothing. A new family is a product change (ADR 013 rule 5): files, licence, these tables, a `FONTS` entry in core and a shape in `font-files.ts` together.

The admin's theme settings show each font as a radio with a line of sample text in that font, so an editor chooses on what they see. Those faces come from `apps/web/static/_admin/font-specimens.css`, which only the theme settings link: every family's roman file (a static family's 400 and 700) and one rule per key on `.ui-font-specimen[data-font]`. The file is the output of `specimenCss()` in `font-files.ts`, and `tokens.test.ts` holds the two equal; after a catalogue change, regenerate it.

## Caching

Caddy serves `/fonts/*` for a year as immutable (`docker/caddy/Caddyfile`), because the application never sees these files. A file keeps its name for as long as its content: new font content means a new file name, or a returning visitor keeps the old file until the year is over.

## A site's own font (MY-302)

A commercial font cannot be in this catalogue (the repository is public), so a site may also have its own heading and body font: a family per role, uploaded as WOFF2 faces with the licence the uploader confirmed (ADR 013 rule 1, amendment of 2026-11-26; `packages/core/src/theme/site-fonts.ts`, migration 0092). An uploaded family replaces the theme's catalogue font for that role on the site; the catalogue choice stays the face of mail and the share card, which cannot carry a licensed web font.

Uploading is a platform operation, not a use case: for now only the platform uploads, and a capability cannot say that because `tenant:admin` holds every capability. Reading is the query `site.font.list` (`content:read`), which the admin, the renderer and an agent share.

```sh
npm run mycel -- fonts add --tenant <slug> --role heading --family Gottak --category sans \
  --weight 700 --style normal --file Gottak-Bold.woff2 \
  --licence-holder "<who bought it>" --licence-source "<foundry or reseller>" \
  --licence-domain example.org,www.example.org --self-hosting-allowed
npm run mycel -- fonts list --tenant <slug>
npm run mycel -- fonts remove --tenant <slug> --role heading [--weight 700 --style normal]
```

| Rule               | Value                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| File               | WOFF2 only, at most 1 MiB per face, structurally checked by the wordmark's validator (`validateWoff2` in `@mycel/media-sharp`) before any write |
| Faces              | weights 100 to 900 in steps of 100, `normal` or `italic`, at most eight per role                                                                |
| Family             | one per role; a different name for a role that has one is refused unless `--replace-family`, which removes the old faces                        |
| Licence            | holder, source and one to twenty domains; `--self-hosting-allowed` is required and records when it was confirmed                                |
| Served at          | `<site>/_font/<role>-<weight>-<style>-<hash>.woff2`, immutable, from the site's own hostname; an older hash is a 404                            |
| In the stylesheet  | the fixed family `Mycel Site Heading` or `Mycel Site Body`, then the system face of the uploaded category; never the uploaded name              |
| Export and erasure | `site_fonts` and `site_font_faces` travel in a tenant export and are deleted with the tenant                                                    |
| Audit              | `platform.site.font.upload` and `platform.site.font.remove`, actor `cli`                                                                        |

Not built: a licence counter some licences require (Monotype, MyFonts; a fixed host list, named in the site's privacy statement) and an external font kit (Adobe Fonts, Fonts.com) as an ADR 022 exception per site.
