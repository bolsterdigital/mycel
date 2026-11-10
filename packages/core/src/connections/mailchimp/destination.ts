// Only a closed Mailchimp API audience is a provider destination. Rejected: accepting an
// arbitrary URL under the provider name and trusting a later transport to interpret it.
export function mailchimpTarget(destination: string | null) {
  if (!destination) return null;
  try {
    const url = new URL(destination);
    const server = /^(us[1-9][0-9]{0,2})\.api\.mailchimp\.com$/.exec(url.hostname);
    const audience = /^\/3\.0\/lists\/([a-zA-Z0-9]{1,64})$/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !server ||
      !audience
    )
      return null;
    return { server: server[1]!, audience: audience[1]! };
  } catch {
    return null;
  }
}
