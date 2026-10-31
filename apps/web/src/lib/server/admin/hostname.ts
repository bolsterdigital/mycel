// What an operator pastes into "Hostname" is often a URL (#102): the route forgives it before
// the use case, which stays strict (ADR 014: a hostname is a hostname). Scheme, credentials,
// path, query, fragment, port and white space go; the rest is lower-cased. Anything still wrong
// reaches `tenant.hostname.add` and is refused there with its own message. Rejected: the same
// leniency in core, where HTTP and MCP callers would get a hostname they did not send.
export function pastedHostname(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^/?#@]*@/, '')
    .split(/[/?#]/, 1)[0]!
    .replace(/:\d*$/, '')
    .toLowerCase();
}
