// Keep browser seed envelopes tied to registry metadata; a fixed version breaks future schemas.
// A pure mapping, so `e2e-block-examples.test.mjs` proves it without a browser.
export function blockExamples(definitions) {
  return Object.fromEntries(
    Object.entries(definitions).flatMap(([type, d]) =>
      d.examples.map((e) => [e.name, { type, version: d.version, props: e.props }])
    )
  );
}
