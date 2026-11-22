# ADR 038 - A campaign is presented one way in two structures: landing page and card

- **Status**: accepted
- **Date**: 2026-11-22
- **Amended**: 2026-11-22, the header image overlap and the full card's body (MY-276, below); rule 4's `<details>` and the rejected overlap give way to it
- **Refines**: ADR 033 rule 4 (a full card also shows the campaign text)
- **Builds on**: ADR 004 rule 3 (heading levels from tree depth), ADR 007 (localisation), ADR 009 (HTML first), ADR 016 (access), ADR 018 (per-locale publication), ADR 033 rules 1-3 and 6 (landing page owns publication and copy, campaign owns participation, server decides at submit, caching)
- **Supersedes**: ADR 025 rules 1 (reading order) and 3 (one page header layout) only for a landing page bound to a campaign; ADR 033 rule 4 only where it renders a full card as compact outside open participation

## Context

ADR 033 made a campaign a participation entity whose landing page is an ordinary `page` and whose card is a live reference. The decision said nothing about how either looks, so both inherited the generic shapes: the landing page renders like every page (title, lead, image, then blocks, with the campaign form as one of those blocks) and the full card is a teaser with the form appended below it, without the petition text. In the Otterdam proof (2026-11-22) the owner found both unfinished and asked for one campaign layout: the header image at the top, the petition text on the left and the form on the right, and the same layout when the campaign is placed as a card, with the text collapsible.

The predecessor (Dreamkit `wings-campaigns` and `wings/campaign-card`) has this look, but through two renderers with copied markup, two style sets with their own breakpoints, a CSS background header image without alt, collapsing by `max-height` and a script (the text stays cut off without JavaScript), and a detail page without a `main` landmark. The two drifted apart, which is the complaint. The parts of a campaign also sit at different places in the document outline: on the landing page the title is the page's `h1`, inside a card it is a heading of the host page.

Two accepted rules say otherwise. ADR 025 rules 1 and 3 fix the header order (title, lead, image) and give pages one header layout. ADR 033 rule 4 lists what compact and full show and makes full render as compact outside open participation. This ADR supersedes those parts for a bound landing page and a full card, and refines ADR 033 rule 4 with the campaign text; their principles stay: the header is document metadata, a page refuses a stored layout choice, a card is a live reference to one public projection and never a copy.

## Decision

1. **One presentation model, two structures.** A campaign renders from one resolved model (kind, participation phase, title, lead, header image, counter, action, body, landing link) produced by one resolver and drawn by one layout component, with the same areas and classes on the landing page and in a card. The context decides only the elements: header element, heading level, image loading and whether the body is collapsible. One stylesheet lays the areas out with a container query on the layout itself, so a card in the content column and one on the wide rail each choose their own arrangement; no viewport media queries decide the columns.

2. **A landing page bound to a campaign has the campaign layout.** The binding chooses it, not a stored field: a page still refuses `presentation.header` (ADR 025 rule 3), and an unbound page keeps the one page header. In the campaign layout the header image comes first, full width above the columns, with its per-locale alt (ADR 025 rule 2) and loaded eagerly as the likely largest paint; then the intro (kind, title as the page's only `h1`, lead), the action area (counter and form, or where participation stands) and the body (the page's blocks). Reading, tab and DOM order is intro, action, body. When the container is wide enough the action area stands beside intro and body; otherwise everything is one column in that same order, so on a narrow screen the form follows the title and lead directly. This deliberately differs from the predecessor, which put the text first: the lead says what one signs, and on the landing page the body does not collapse, so text first would put the form screens away. The body on the landing page never collapses.

3. **Heading levels come from the context, never from stored data.** Block renderers receive the depth they render at (1 = directly under the document title, today's only value) and derive their heading levels from it; a rich-text heading of level n renders at depth + n. On the landing page the campaign title is the only `h1`, the action area has an `h2`, and body headings start at `h2`. In a card the title takes the card block's own level (`h2` at the top of a tree, deeper inside a titled container), body headings are one level below the card title, the action area has no heading of its own (the card title names it), and a card never renders an `h1`. A level beyond `h6` is refused as today. The counter is a paragraph, not a heading.

4. **A full card shows the campaign text, collapsible, from the same revision.** Refining ADR 033 rule 4: besides title, lead, image, counter and form, a full card renders the text blocks (`heading`, `rich-text`, `quote`, `callout`, `image`) of the same published landing revision in the requested locale that supplies its title and counter; there is still one projection and the revision id already in the host page's ETag (ADR 033 rule 6) covers it. Other blocks are left out, and then the body ends with a link to the landing page. The campaign's own form never appears in the body. The body sits in a native `<details>`, closed by default; a short body (a fixed word limit without subheadings, set in code with a test) is shown open without `<details>`, and an empty one is absent. Ids inside a card derive from the card block's id, so two cards for one campaign on a page do not collide. The card title links to the landing page; the header image in a card is decorative (the title names the card) and loads lazily. Compact stays a teaser on the same intro and counter parts. Feeds, search, Markdown and `llms.txt` keep rendering a card as a link with title and lead only.

5. **Outside open participation every form of the campaign keeps its layout.** Refining ADR 033 rule 4's "renders as compact with the result": the landing page, the full card and the compact card keep their layout, and the action area shows where participation stands instead of the form (closed: the final count against the goal; not yet open: the opening date when there is one, without a count). Rule 3 of ADR 033 is unchanged: the server still decides at submit time.

6. **The campaign's form comes from the campaign, not from the block tree.** The action area renders the form of `campaigns.formId`, on the landing page and in a full card. Creating a campaign creates its landing page without a `form` block, and a `form` block in any body that places the campaign's own form renders nothing (one form per definition per page, as today). Existing content follows the clean-cut rule for installations without production sites: fixtures and demo content are rewritten, stored data is not converted.

7. **The counter is shown whenever the goal is public, also while open.** It is a large figure with its unit, a native `<progress>` and the goal below it; with nothing counted yet it says so instead of "0 of". Figures and amounts use the existing count formatting, so a fundraiser's amounts do not diverge. No count-up animation: it needs script and adds nothing the figure does not say.

8. **The thank-you state of a campaign belongs to its landing page.** A campaign form accepted from the landing page or from a card redirects to the thank-you view of the landing page (as ADR 033 rule 2 already says), carrying a return path to the page it came from that is validated as a site path. That view uses the campaign layout with the counter, plain share links without third-party scripts, and a link back. Ordinary forms keep their own thank-you view.

9. **Everything works without JavaScript.** Public pages render on the server; `<details>` and `<summary>` are native and keyboard operable; the form posts natively; `<progress>` is native. A sticky action area, if added, is CSS only, bounded by the layout, and only where the columns stand side by side.

### Overlap and an open card body (2026-11-22, MY-276)

The owner's review of the built layout on the Otterdam proof (2026-11-22, evening) found it short of the predecessor's petition: a lower header image across the full width, the text and the form sliding into it, and the card's text open, cut off with a fade and "read more", instead of a closed disclosure. That is the decision; it amends this ADR as follows.

1. **The intro and the action area overlap the campaign's own header image.** The image runs the full width of the layout, lower than an ordinary page header, and the intro and the action area stand over its lower edge as cards, the action area further than the intro on a wide container and not at all on a narrow one, where it follows the intro. The overlap comes from grid rows the image shares with the columns, so nothing reaches outside the layout or over content above it. The image stays a `<picture>` with its per-locale alt and loading hint, never a CSS background; its caption and credit stand on the image where the cards do not cover it. Without a header image there is no overlap. This replaces the rejected alternative "overlapping the header image with negative margins": negative margins stay rejected, the overlap itself is not.
2. **A full card's body is open by default.** Replacing the `<details>` of rule 4: the text stands open; a long text is cut off with a fade and a "read more" button, and after expanding a "read less" button returns focus and scroll position to the start of the text. Without JavaScript the whole text stands there without a fade (ADR 009); the script measures, shortens with a class (never a `style` attribute, given the CSP) and adds a real `<button aria-expanded aria-controls>`. A short body gets no button, as before. On the landing page the body stays whole (rule 2).

Rule 2's order (intro, action, body) and every other rule are unchanged. Item 1 is MY-276 PR 1, item 2 MY-276 PR 2.

## Rejected alternatives

- **Porting the predecessor's two renderers**: the drift between card and landing page is the problem being solved.
- **Collapsing by `max-height` and a toggle script**: without script the rest of the text is unreachable.
- **A campaign text field on the campaign row**: two sources for one text, which ADR 033 rule 1 rejected.
- **Keeping the form a freely placed block**: then each landing page decides its own layout and there is no shared structure for the card to repeat.
- **A stored `presentation.header` value for the campaign layout**: the binding already determines it; a stored choice could contradict the binding.
- **A heading level stored per block**: heading levels follow the outline the block lands in (ADR 004 rule 3); the same block appears at two depths.
- **Overlapping the header image with negative margins, or the image as a CSS background**: the overlap bled into content above in the predecessor, and a background image has no alt and no loading hint. (Since 2026-11-22 the overlap itself is decided, through shared grid rows; see the amendment above.)

## Consequences

- Block renderers take a depth instead of a fixed constant; at depth 1 every existing render stays byte-identical.
- The public campaign projection gains the text blocks of the landing revision, with the availability check it already has (no body for a draft, trashed, other-locale or restricted target).
- `campaign.landing.create` stops placing a form block; Otterdam, the demo seed, e2e fixtures and the quality corpus move with it, and the corpus campaign route becomes a bound landing page with expected headings `[1, 2]`.
- The thank-you redirect of a campaign post changes from the host page to the landing page; ordinary forms are unchanged.
- The admin preview renders a bound landing page in the same layout as the public route.
- Building this is MY-267 PR 1 to 5; each PR names the rule of this ADR it carries out.
