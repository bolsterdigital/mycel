// Operator login over OIDC (brief #7 decision 6): authorization code flow with PKCE (S256)
// always, `client_secret_post` when OIDC_CLIENT_SECRET is set, a public client otherwise.
// `openid-client` (MIT) over our own code: identity is commodity with liability, and the nonce,
// state, issuer and audience checks are exactly where two hundred lines of our own go wrong.
// Core knows nothing of OIDC; this file hands validated claims to `IdentityStore.login`.
//
// The flow's own state (state, nonce, code verifier, where to return) travels in a signed,
// short-lived cookie scoped to /admin, so no server-side session store is needed. Its `typ`
// keeps it apart from every other payload the shared Signer signs.

import * as client from 'openid-client';
import { runtime } from '../runtime.js';

export const OIDC_COOKIE = 'mycel_oidc';
export const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;

export class LoginNotConfigured extends Error {}

let discovered: Promise<client.Configuration> | undefined;

/** Discovery once per process; a failed discovery is retried on the next login. */
function configuration(): Promise<client.Configuration> {
  const { config } = runtime();
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID)
    return Promise.reject(new LoginNotConfigured('operator login is not configured'));
  const issuer = new URL(config.OIDC_ISSUER);
  discovered ??= client
    .discovery(
      issuer,
      config.OIDC_CLIENT_ID,
      undefined,
      config.OIDC_CLIENT_SECRET
        ? client.ClientSecretPost(config.OIDC_CLIENT_SECRET)
        : client.None(),
      // Plain http only for a local issuer (the mock IdP); Config refuses it in production.
      issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined
    )
    .catch((e: unknown) => {
      discovered = undefined;
      throw e;
    });
  return discovered;
}

export const redirectUri = () => `${runtime().config.PUBLIC_BASE_URL}/admin/callback`;

interface Pending {
  typ: 'oidc';
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

/** The IdP URL to send the browser to, and the cookie value that remembers this attempt. */
export async function startLogin(returnTo: string): Promise<{ url: URL; cookie: string }> {
  const rt = runtime();
  const config = await configuration();
  const pending: Pending = {
    typ: 'oidc',
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
    returnTo,
    exp: rt.clock.now().getTime() + OIDC_COOKIE_TTL_MS,
  };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: rt.config.OIDC_SCOPES,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  return { url, cookie: await rt.signer.sign(JSON.stringify(pending)) };
}

export interface VerifiedLogin {
  claims: {
    issuer: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
  };
  returnTo: string;
}

/**
 * Exchange the code from the callback URL, checking state, nonce, PKCE and the ID token. Null
 * when the attempt cookie is missing, forged or expired; throws when the IdP's answer fails a
 * check or carries no e-mail address.
 */
export async function finishLogin(
  callbackSearch: string,
  cookie: string | undefined
): Promise<VerifiedLogin | null> {
  const rt = runtime();
  const raw = cookie ? await rt.signer.verify(cookie) : null;
  let pending: Pending;
  try {
    pending = JSON.parse(raw ?? 'null') as Pending;
  } catch {
    return null;
  }
  if (!pending || pending.typ !== 'oidc' || pending.exp <= rt.clock.now().getTime()) return null;

  const config = await configuration();
  // The URL the IdP redirected to, rebuilt from configuration: behind a proxy the request URL
  // may not be the registered redirect URI.
  const tokens = await client.authorizationCodeGrant(
    config,
    new URL(`${redirectUri()}${callbackSearch}`),
    {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    }
  );
  const claims = tokens.claims();
  if (!claims) throw new Error('the IdP returned no ID token');
  if (typeof claims['email'] !== 'string' || !claims['email'])
    throw new Error('the ID token has no email claim; request the email scope');
  return {
    returnTo: pending.returnTo,
    claims: {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims['email'],
      emailVerified: claims['email_verified'] === true,
      name: typeof claims['name'] === 'string' ? claims['name'] : null,
    },
  };
}
