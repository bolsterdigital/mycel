// Keep browser seed envelopes tied to registry metadata; a fixed version breaks future schemas.
// This pure mapping is shared with the existing infrastructure regression suite.
export function blockExamples(definitions) {
  return Object.fromEntries(
    Object.entries(definitions).flatMap(([type, d]) =>
      d.examples.map((e) => [e.name, { type, version: d.version, props: e.props }])
    )
  );
}
