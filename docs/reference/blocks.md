# Blocks

<!-- Generated from the block registry by apps/web/src/lib/editor/block-docs.ts. Do not edit: run `npm run docs:blocks`. -->

Every block type a page or article can hold (ADR 004, ADR 013 rule 2, ADR 020), as `packages/core/src/content/block-types.ts` defines it: its props as the admin edits them, its enumerated values and its examples. A block is stored as `{ id, type, version, props }`; agents and the API write the same props through the block operations (`content.item.insert`, `move`, `remove`, `set_props`, `split_insert`). The JSON Schema of every type is in `/openapi.json` and the MCP tool list.

The **label** is the English admin copy; **presence** says whether a published block needs the field. A localised field holds one value per locale of the document; publishing a locale needs a value in it for every required field and every optional one that is filled in another locale.

## `heading` (Heading)

Version 1.

| Prop   | Label | Kind           | Presence |
| ------ | ----- | -------------- | -------- |
| `text` | Text  | localised text | required |

Examples: `heading`.

## `signup-form` (Signup form (old))

Version 1.

| Prop     | Label   | Kind                | Presence |
| -------- | ------- | ------------------- | -------- |
| `formId` | Form id | form reference (id) | required |

Examples: `signup-form`.

## `rich-text` (Text)

Version 1.

| Prop      | Label | Kind                                                    | Presence |
| --------- | ----- | ------------------------------------------------------- | -------- |
| `content` | Text  | localised rich text (Markdown subset in the no-JS form) | required |

Examples: `rich-text`.

## `paywall` (Paywall)

Version 1.

No props.

Examples: `paywall`.

## `image` (Image)

Version 1.

| Prop                  | Label                       | Kind                                                          | Presence                   |
| --------------------- | --------------------------- | ------------------------------------------------------------- | -------------------------- |
| `mediaId`             | Image                       | image (media id)                                              | required                   |
| `decorative`          | Decorative (no description) | yes or no                                                     | required                   |
| `alt`                 | Description (alt text)      | localised text                                                | optional (null when empty) |
| `caption`             | Caption                     | localised caption: the file’s, none, or its own per locale    | optional                   |
| `credit`              | Own credit for this use     | group                                                         | optional                   |
| `credit.work`         | Work                        | group                                                         | optional (null when empty) |
| `credit.work.title`   | Title                       | text                                                          | required                   |
| `credit.work.maker`   | Maker                       | text                                                          | required                   |
| `credit.photographer` | Photographer                | text                                                          | optional (null when empty) |
| `layout`              | Layout                      | one of `content`, `wide`, `full`, `float-left`, `float-right` | required                   |

Examples: `image-content`, `image-wide-caption-credit` (Caption and credit override the asset for this use), `image-full-decorative` (Decorative: no alt text, the renderer writes alt=""), `image-float-left`, `image-float-right`.

## `hero` (Hero)

Version 1.

| Prop                        | Label                       | Kind                                                       | Presence                   |
| --------------------------- | --------------------------- | ---------------------------------------------------------- | -------------------------- |
| `variant`                   | Variant                     | one of `minimal`, `cover`, `split`                         | required                   |
| `title`                     | Title                       | localised text                                             | required                   |
| `body`                      | Body text                   | localised multi-line text                                  | optional                   |
| `image`                     | Image                       | group                                                      | optional                   |
| `image.mediaId`             | Image                       | image (media id)                                           | required                   |
| `image.decorative`          | Decorative (no description) | yes or no                                                  | required                   |
| `image.alt`                 | Description (alt text)      | localised text                                             | optional (null when empty) |
| `image.caption`             | Caption                     | localised caption: the file’s, none, or its own per locale | optional                   |
| `image.credit`              | Own credit for this use     | group                                                      | optional                   |
| `image.credit.work`         | Work                        | group                                                      | optional (null when empty) |
| `image.credit.work.title`   | Title                       | text                                                       | required                   |
| `image.credit.work.maker`   | Maker                       | text                                                       | required                   |
| `image.credit.photographer` | Photographer                | text                                                       | optional (null when empty) |
| `image.layout`              | Layout                      | one of `content`                                           | required                   |
| `actions`                   | Buttons                     | 0–2 buttons: a localised label and an item or a URL        | required                   |
| `width`                     | Width                       | one of `content`, `wide`, `full`                           | required                   |
| `align`                     | Alignment                   | one of `start`, `center`, `end`                            | required                   |

Examples: `hero-minimal`, `hero-cover`, `hero-split-long-label`, `hero-minimal-content`.

## `cta` (Call to action)

Version 1.

| Prop      | Label     | Kind                                                | Presence |
| --------- | --------- | --------------------------------------------------- | -------- |
| `variant` | Variant   | one of `band`, `card`                               | required |
| `title`   | Title     | localised text                                      | required |
| `body`    | Body text | localised multi-line text                           | optional |
| `actions` | Buttons   | 1–2 buttons: a localised label and an item or a URL | required |
| `width`   | Width     | one of `content`, `wide`, `full`                    | required |
| `align`   | Alignment | one of `start`, `center`, `end`                     | required |

Examples: `cta-band`, `cta-card-two-actions`, `cta-full-end`.

## `callout` (Callout)

Version 1.

| Prop      | Label     | Kind                                                    | Presence |
| --------- | --------- | ------------------------------------------------------- | -------- |
| `variant` | Variant   | one of `info`, `note`, `warning`                        | required |
| `title`   | Title     | localised text                                          | optional |
| `body`    | Body text | localised rich text (Markdown subset in the no-JS form) | required |

Examples: `callout-info`, `callout-note`, `callout-warning`.

## `faq` (Questions and answers)

Version 1.

| Prop                 | Label    | Kind                                                    | Presence |
| -------------------- | -------- | ------------------------------------------------------- | -------- |
| `variant`            | Variant  | one of `list`, `accordion`                              | required |
| `title`              | Title    | localised text                                          | optional |
| `entries`            | Question | list of 1–30                                            | required |
| `entries[].question` | Question | localised text                                          | required |
| `entries[].answer`   | Answer   | localised rich text (Markdown subset in the no-JS form) | required |

Examples: `faq-list`, `faq-accordion`.

## `quote` (Quote)

Version 1.

| Prop                 | Label         | Kind                             | Presence |
| -------------------- | ------------- | -------------------------------- | -------- |
| `text`               | Text          | localised multi-line text        | required |
| `attribution`        | Attribution   | group                            | required |
| `attribution.name`   | Name          | text                             | required |
| `attribution.role`   | Role          | localised text                   | optional |
| `attribution.source` | Source        | localised text                   | optional |
| `attribution.url`    | Address (URL) | text                             | optional |
| `variant`            | Variant       | one of `blockquote`, `pullquote` | required |
| `width`              | Width         | one of `content`, `wide`, `full` | required |

Examples: `quote-blockquote`, `quote-pullquote-wide`, `quote-full`.

## `video-embed` (Video)

Version 1.

| Prop       | Label    | Kind                             | Presence |
| ---------- | -------- | -------------------------------- | -------- |
| `provider` | Service  | one of `youtube`, `vimeo`        | required |
| `videoId`  | Video id | text                             | required |
| `title`    | Title    | localised text                   | required |
| `caption`  | Caption  | localised multi-line text        | optional |
| `width`    | Width    | one of `content`, `wide`, `full` | required |

Examples: `video-youtube`, `video-vimeo-wide`, `video-full`.

## `form` (Form)

Version 1.

| Prop      | Label   | Kind                             | Presence |
| --------- | ------- | -------------------------------- | -------- |
| `formId`  | Form id | form reference (id)              | required |
| `variant` | Variant | one of `default`, `card`         | required |
| `width`   | Width   | one of `content`, `wide`, `full` | required |

Examples: `form-default`, `form-card-wide`, `form-full`.

## Rich text in the no-JavaScript form

A rich-text field is a `textarea` with a Markdown subset that reads back into exactly the stored document (`apps/web/src/lib/editor/markdown.ts`):

| Write                                                                         | For                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `## `, `### `, `#### ` at the start of a line                                 | a heading at relative level 1, 2 or 3 (h2 to h4 at the top of a page) |
| `**bold**`, `_italic_`, `` `code` ``                                          | marks; they switch on and off, so they may start or end inside a word |
| `- ` or `1. ` at the start of a line, indented by the marker’s width to nest  | a bullet or numbered list, three levels deep at most                  |
| a blank line                                                                  | a new paragraph                                                       |
| `\` at the end of a line, or `<br>`                                           | a line break inside a paragraph                                       |
| `[text](https://…)`, `[text](/path)`, `[text](mailto:…)`, `[text](item:<id>)` | a link; `item:` links to a page or article of the site by id          |
| `[text][^1]` and a line `[^1]: note` at the end                               | a footnote on that text                                               |
| `\` before `*`, `_`, `` ` ``, `[` or `]`; `&#n;` with a character code        | the character itself                                                  |

A single newline inside a paragraph is a space, as in Markdown. Text that is unchanged in the form keeps its stored JSON exactly.
