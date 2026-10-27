# Content rail construction evidence, 2026-10-27

The shared layout keeps default Inter at 18px and a 65ch measure: 733.5 CSS px. The wide rail remains 1088px. The baseline on `9a677ca` had a 1408px title beside 733.5px prose at a 1440px viewport. Six composition assertions failed on title/prose alignment at 768/1440px; the repaired registration gives both the same inherited length. [Baseline samples](baseline.txt) retain the failing observations. No theme defaults or stored documents changed.

The [layout contract](../../architecture/content-layout.md) describes the shared rails, container-relative gutters, float containment, inner section measures and operator-shell boundary. The existing production renderer serves all samples, with synthetic media and references.

## Compositions and visual observations

| Composition  | 320px                                | 768px                                | 1440px                                | Observation                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------ | ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Information  | [image](grid-information-v1-320.png) | [image](grid-information-v1-768.png) | [image](grid-information-v1-1440.png) | Prose, title and FAQ share the reading rail. The wide image and CTA retain their outer rail; caption and labels remain legible on mobile. This is a short information composition, not a long-read substitute.                                                           |
| Campaign     | [image](campagne-320.png)            | [image](campagne-768.png)            | [image](campagne-1440.png)            | Cover, wide media and form panel retain distinct backgrounds. The form and CTA interior stay within the reading measure. Whole actions wrap, including the long secondary label.                                                                                         |
| Long article | [image](quality-article-v3-320.png)  | [image](quality-article-v3-768.png)  | [image](quality-article-v3-1440.png)  | The existing 2,000-word fixture retains four local assets, lists and quotation. Full media reach the available page edge, captions remain bounded, and mobile floats return to flow. A full visual editorial assessment remains separate from these construction checks. |

All nine default-layout samples report zero horizontal page overflow. Saved previews share the same title/prose measure for all three documents. Page-editor live iframes match a public page at the same available width. The article currently has no automatic live-preview panel: its unchanged native form is submitted to the actual draft-preview route to verify the same renderer, without claiming that missing editor task works.

## Enlargement and UI gate

[Actual Chromium 200% zoom](browser-zoom-200.png) uses the browser's tabs zoom API, not pinch scaling or CSS zoom. The [record](browser-zoom.json) shows Chromium 156.0.8078.4 changing from a 1440px CSS viewport and pixel ratio 1 to a 720px CSS viewport at pixel ratio 2. Title/prose width is 688px; full media is 720px; no overflow.

The existing hero/CTA gate retains [320px normal text](blocks-campagne-320-100.png) and [320px at 200% text](blocks-campagne-320-200.png). Whole labels, no clipping/ellipsis, 44px targets and DOM action order are asserted by `blocks.spec.ts`. The composition suite additionally checks nl/en with separate 200% text and combined text-spacing stress. A 400px page inside a 1440px browser proves that container size, rather than the monitor, controls floats and full media. Existing registry examples remain the per-variant coverage; no block schema, editor choice or snapshot changed.

## Limits

This is grid construction evidence. FAQ width controls and their versioned editor roundtrip are subsequent work. Named slots, campaign cards and complete editorial acceptance retain their own delivery contracts. No claim is made that the complete desired block catalogue is implemented.

Local Lighthouse was not measured in this run. The existing campaign/article CI matrix remains applicable; information-page seed/manifest integration is separately owned, and missing information/preview Lighthouse cells stay `not-measured`. Safari/Firefox manual zoom, assistive-technology release checks and real-user performance are also `not-measured`. Existing writer/cache findings remain with their original owners. Scores and thresholds were not relaxed.
