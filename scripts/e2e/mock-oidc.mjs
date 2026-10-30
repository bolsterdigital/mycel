#!/usr/bin/env node
// A minimal OpenID Provider for development and the e2e gate (brief #7 decision 8): discovery,
// an HTML "sign in as" form that works without JavaScript, a token endpoint that checks the PKCE
// verifier, and a JWKS. One RSA key pair per start; ID tokens are RS256 JWTs assembled by hand.
// Only node:http and node:crypto. The subject is derived from the address, so the same address
// is the same operator across restarts; untick "verified" to log in with an unverified address.
//
// Never for production: it signs whatever address you type. It refuses to start with
// NODE_ENV=production, and the app's Config refuses an http issuer there.
// Rejected: Zitadel in CI (a secret, the network, an account per run).
//
//   node scripts/e2e/mock-oidc.mjs        # MOCK_OIDC_PORT (8799), MOCK_OIDC_USER (prefilled address)

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

if (process.env.NODE_ENV === 'production') {
  console.error('mock-oidc: refusing to run with NODE_ENV=production');
  process.exit(1);
}

const port = Number(process.env.MOCK_OIDC_PORT ?? 8799);
const issuer = `http://127.0.0.1:${port}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomBytes(8).toString('hex');
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
/** code -> what the token endpoint needs to check and put in the ID token. */
const codes = new Map();

const b64url = (data) => Buffer.from(data).toString('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest();
const subjectOf = (email) => `mock-${sha256(email).toString('hex').slice(0, 20)}`;
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function idToken(claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(claims));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function formBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

const REQUIRED = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'];

function signInPage(params) {
  const hidden = [...REQUIRED, 'code_challenge_method', 'scope']
    .map((k) => `<input type="hidden" name="${k}" value="${escape(params.get(k) ?? '')}">`)
    .join('');
  const user = params.get('login_hint') ?? process.env.MOCK_OIDC_USER ?? '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock IdP: sign in</title></head>
<body><main><h1>Mock IdP</h1><p>Development only: signs any address you enter.</p>
<form method="post" action="/authorize">${hidden}
<p><label for="email">E-mail</label><br><input id="email" name="email" type="email" required value="${escape(user)}"></p>
<p><label for="name">Name</label><br><input id="name" name="name" type="text"></p>
<p><input id="verified" name="verified" type="checkbox" value="1" checked> <label for="verified">Address verified</label></p>
<p><button type="submit">Sign in</button></p></form></main></body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', issuer);
  try {
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration')
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email'],
        claims_supported: ['sub', 'email', 'email_verified', 'name'],
      });
    if (req.method === 'GET' && url.pathname === '/jwks') return send(res, 200, { keys: [jwk] });

    if (url.pathname === '/authorize') {
      const params = req.method === 'POST' ? await formBody(req) : url.searchParams;
      const missing = REQUIRED.filter((k) => !params.get(k));
      if (req.method === 'GET' && params.get('response_type') !== 'code')
        missing.push('response_type=code');
      if (params.get('code_challenge_method') !== 'S256')
        missing.push('code_challenge_method=S256');
      if (missing.length)
        return send(res, 400, `invalid request: ${missing.join(', ')}`, 'text/plain');
      if (req.method === 'GET')
        return send(res, 200, signInPage(params), 'text/html; charset=utf-8');

      const email = (params.get('email') ?? '').trim();
      if (!email) return send(res, 400, 'email is required', 'text/plain');
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        clientId: params.get('client_id'),
        redirectUri: params.get('redirect_uri'),
        challenge: params.get('code_challenge'),
        nonce: params.get('nonce'),
        email,
        verified: params.get('verified') === '1',
        name: params.get('name') || null,
        expires: Date.now() + 60_000,
      });
      const back = new URL(params.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const body = await formBody(req);
      const grant = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (
        body.get('grant_type') !== 'authorization_code' ||
        !grant ||
        grant.expires < Date.now() ||
        grant.redirectUri !== body.get('redirect_uri') ||
        grant.clientId !== body.get('client_id') ||
        b64url(sha256(verifier)) !== grant.challenge
      )
        return send(res, 400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, {
        access_token: randomBytes(24).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken({
          iss: issuer,
          sub: subjectOf(grant.email.toLowerCase()),
          aud: grant.clientId,
          iat: now,
          exp: now + 300,
          nonce: grant.nonce,
          email: grant.email,
          email_verified: grant.verified,
          ...(grant.name ? { name: grant.name } : {}),
        }),
      });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('mock-oidc:', e);
    send(res, 500, { error: 'server_error' });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`mock-oidc: issuer ${issuer}`));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
