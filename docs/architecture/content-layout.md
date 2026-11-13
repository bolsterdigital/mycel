# Shared content rails

Public pages, saved previews and live previews use `base.css` and the same block renderer. The rails belong to the available page container. Rejected: copying Wings' viewport offsets or adding a separate preview layout with page-specific margin overrides.

## Horizontal layout

- `--content-width` resolves the validated theme's `measure` in the page's body font. Its registered length is inherited by headings, captions and section interiors. The computationally independent registration default is `640px`; a relative initial value would invalidate the registration and let headings recompute `ch` at their own size. With default Inter at 18px, 65ch measures 733.5 CSS px at a 1440px viewport. Keep the existing theme default and its 45 to 85ch range.
- `--wide-width` remains 68rem (1088px at the default root size). Header/footer navigation and wide blocks share this rail. Titles and ordinary blocks share the content rail; a wider background does not widen the form, quotation or CTA text within it.
- Full media occupy the page container, rather than `100vw`. Captions have their own content measure and gutters. Block variants continue to come from validated content, without arbitrary CSS or a storage migration.
- The page is an inline-size query container. Its gutters are the smaller of 1rem and 4% of that container; section insets are the smaller of the density-dependent spacing and 5%. A narrow preview therefore has the same usable width as a public page of that width.
- Floats return to normal flow at a container width of 40rem or less. Wide/full blocks clear them, and the page's flow root contains trailing floats before the footer. DOM order remains unchanged.

The operator shell's `.page.admin` does not become a public query container or flow root. Existing admin width rules remain authoritative. Nested layout components must establish their own bounded container before supporting breakout variants; this contract does not claim named slots or arbitrary nested block trees have shipped.

## Site chrome

The site header and footer are full-width bands whose content sits on the wide rail: their inline padding is `--wide-inset`, the larger of the gutter and half of what the wide rail leaves of the page. Logo, navigation, footer text, footer links and credit therefore start and end exactly where a wide block does, at every width, and the band's border runs to the page edges.

| Rail    | Token                                  | Used by                                                |
| ------- | -------------------------------------- | ------------------------------------------------------ |
| Content | `--content-width` (theme `measure`)    | prose, ordinary blocks, the interiors of wide sections |
| Lead    | `--lead-width` (44rem)                 | the centred lead under the title                       |
| Title   | `--title-width` (52rem)                | the centred item title                                 |
| Wide    | `--wide-width` (68rem), `--wide-inset` | wide blocks, header, footer                            |
| Full    | the page container                     | full media and section backgrounds                     |

The header is one row while the logo and the whole navigation fit: logo at the start, navigation ending on the rail. Otherwise the navigation moves under the logo as a whole and starts on the rail; a lone flex item under `space-between` sits at the start. There is no breakpoint, so a long label or 200% text cannot overrun one. The logo stays within 12rem or 45% of the viewport and 4rem high. The cover header's `--site-header-height` assumes this one-row header; a header that wraps pushes the cover's arrow down by the difference, it does not hide it. A band without links renders no navigation landmark. Menus, the action buttons, the panel and measuring what fits belong to #107, which places its bar on this rail.

The item preview renders the header's identity without navigation or footer; that difference is the preview's, not the rail's.

## Vertical rhythm

The existing density-scaled spacing tokens remain the source of rhythm: block separation is `space-3`, paragraph spacing is `space-2`, and heading spacing is `space-4`/`space-2`. Inner content is centred without resetting these block margins. Full backgrounds and narrow text are separate concerns. No per-composition spacing patches are used.

The two transitions to the chrome are one distance each: a public page's block padding is `space-4`, and its first and last element (inside a preview's `display: contents` wrapper too) give up their outer margin. A page that opens with its title or with a cover, or ends on a paragraph, a wide card row or a FAQ, sits the same distance from the header and the footer. The cover header removes the top padding and meets the header directly. The operator's `.page.admin` keeps its own padding.

## Evidence and scope

`apps/web/e2e/public-site.spec.ts` composes an information page from existing registry-backed synthetic content, reuses the campaign with its real form and the 2,000-word article with four local images, and checks 320/768/1440px, title/prose alignment, container reflow and saved/live preview parity. The same compositions and a site with navigation, footer text, links and credit check the chrome rails and both transitions at 320/768/1440px against probe elements of the page's own rails (`apps/web/e2e/lib/rails.ts`). Screenshots and rail metrics are Playwright artifacts. Existing block registry, no-JavaScript, text-spacing, demanding-theme and action-layout suites remain applicable.

The information fixture is `grid-information-v1`; the campaign and long article retain the quality corpus's existing fixture identities. Its Lighthouse manifest/seed integration needs the separately owned quality runner wiring. Missing Lighthouse cells, manual Safari/Firefox zoom and release assistive-technology checks are not established by these layout tests. FAQ v2 adds content/wide/full section rails to both variants. The heading, each question and each answer retain the content measure inside the actual section container, including narrow previews. Campaign entities, named slots, reader access and provider embeds retain their own delivery contracts.

The article's native editor currently links to saved preview and the enhanced writer, without the page editor's automatic live iframe. The composition test submits its unmodified native form to the real draft-preview route to compare layout; this is renderer evidence only. Completing the writer's live-preview task stays with editor integration work.
