/**
 * A mock of the Microsoft identity platform's v2.0 endpoints for the
 * end-to-end suite, over https, answering as `login.microsoftonline.com` and
 * `graph.microsoft.com` (compose.yml gives it both names):
 *
 * - per tenant, `/{tenant}/v2.0/.well-known/openid-configuration`, for a tenant
 *   id (a GUID) and for the multi-tenant `organizations` and `common`, whose
 *   document names the issuer template
 *   `https://login.microsoftonline.com/{tenantid}/v2.0`, as the platform's do;
 * - `/{tenant}/oauth2/v2.0/authorize`, `/{tenant}/oauth2/v2.0/token` and
 *   `/{tenant}/discovery/v2.0/keys`; and Graph's `/oidc/userinfo`.
 *
 * It checks what the platform checks: the client, the `redirect_uri`, the
 * `scope`, PKCE with S256, the code (good once, at the tenant it was issued
 * for), the client secret in the token request's body (`client_secret_post`,
 * the way this plugin authenticates) and the verifier. It signs ID tokens
 * with RS256 under one key all tenants share, as the platform does.
 *
 * The suite drives it through a control API under `/_control/`: it sets the
 * ID token claims of the next sign-in (the tenant and the issuer included,
 * so it can make a token the platform itself would not, and see the server
 * refuse it), and reads back every token the mock issued and every call it
 * answered, so it can look for those tokens in the server's database and
 * logs.
 *
 * No dependencies: it runs on the plain node image.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const PORT = Number(process.env.PORT ?? '443');
const CLIENT_ID = process.env.MOCK_MICROSOFT_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MOCK_MICROSOFT_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.MOCK_MICROSOFT_REDIRECT_URI ?? '';
if (CLIENT_ID === '' || CLIENT_SECRET === '' || REDIRECT_URI === '') {
  throw new Error(
    'MOCK_MICROSOFT_CLIENT_ID, MOCK_MICROSOFT_CLIENT_SECRET and MOCK_MICROSOFT_REDIRECT_URI are required'
  );
}

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com';
const GRAPH_HOST = 'graph.microsoft.com';
const MULTI_TENANT = new Set(['common', 'organizations']);
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `/{tenant}/rest`: the tenant segment of a login path, and the rest. */
const TENANT_PATH = /^\/([^/]+)(\/.*)$/;

// One key signs every tenant's tokens, as the platform's keys are shared.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = randomBytes(20).toString('base64url');
const PUBLIC_JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID };

/** The ID token claims of the next sign-in, beyond the protocol's. The test replaces them. */
let person = {
  sub: 'AAAAAAAAAAAAAAAAAAAAAFirstPersonSubject0001',
  oid: '00000000-0000-0000-0000-000000000001',
  tid: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
  name: 'First Person',
  preferred_username: 'first@contoso.example',
  email: 'first@contoso.example',
};

/** Issued codes: the request they answer, and the claims as they were then. */
const codes = new Map();
/** Issued access tokens and the claims each belongs to. */
const people = new Map();
/** Every access token and ID token issued, in order. */
const issued = { accessTokens: [], idTokens: [] };
/** Every call answered, without its credentials. */
const calls = [];

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function s256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store, no-cache',
    ...headers,
  });
  response.end(text);
}

/** An error as the platform's endpoints answer one. */
function platformError(response, status, error, description) {
  return json(response, status, {
    error,
    error_description: `AADSTS00000: ${description}`,
    error_codes: [0],
    timestamp: new Date().toISOString(),
    trace_id: crypto.randomUUID(),
    correlation_id: crypto.randomUUID(),
  });
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The issuer a tenant's discovery document names. */
function issuerOf(tenant) {
  return `${LOGIN}/${MULTI_TENANT.has(tenant) ? '{tenantid}' : tenant}/v2.0`;
}

/** A tenant's discovery document, as the platform serves one (abridged). */
function discovery(tenant) {
  const base = `${LOGIN}/${tenant}`;
  return {
    token_endpoint: `${base}/oauth2/v2.0/token`,
    token_endpoint_auth_methods_supported: [
      'client_secret_post',
      'private_key_jwt',
      'client_secret_basic',
    ],
    jwks_uri: `${base}/discovery/v2.0/keys`,
    response_modes_supported: ['query', 'fragment', 'form_post'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    issuer: issuerOf(tenant),
    request_uri_parameter_supported: false,
    userinfo_endpoint: `${GRAPH}/oidc/userinfo`,
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    device_authorization_endpoint: `${base}/oauth2/v2.0/devicecode`,
    http_logout_supported: true,
    frontchannel_logout_supported: true,
    end_session_endpoint: `${base}/oauth2/v2.0/logout`,
    claims_supported: [
      'sub',
      'iss',
      'cloud_instance_name',
      'cloud_instance_host_name',
      'cloud_graph_host_name',
      'msgraph_host',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'acr',
      'nonce',
      'preferred_username',
      'name',
      'tid',
      'ver',
      'at_hash',
      'c_hash',
      'email',
    ],
    kerberos_endpoint: `${base}/kerberos`,
    tenant_region_scope: MULTI_TENANT.has(tenant) ? null : 'EU',
    cloud_instance_name: 'microsoftonline.com',
    cloud_graph_host_name: 'graph.windows.net',
    msgraph_host: 'graph.microsoft.com',
    rbac_url: 'https://pas.windows.net',
  };
}

function keys(tenant, response) {
  return json(response, 200, {
    keys: [
      {
        kty: PUBLIC_JWK.kty,
        use: 'sig',
        kid: KID,
        n: PUBLIC_JWK.n,
        e: PUBLIC_JWK.e,
        cloud_instance_name: 'microsoftonline.com',
        issuer: issuerOf(tenant),
      },
    ],
  });
}

/** Send the browser back to the client with an error, as the platform does. */
function redirectError(response, redirectUri, state, error, description) {
  const back = new URL(redirectUri);
  back.searchParams.set('error', error);
  back.searchParams.set('error_description', `AADSTS00000: ${description}`);
  if (state !== null) back.searchParams.set('state', state);
  response.writeHead(302, { location: back.href });
  response.end();
}

function authorize(tenant, url, response) {
  const query = url.searchParams;
  const redirectUri = query.get('redirect_uri');
  const state = query.get('state');
  // The platform shows its own error page when it cannot trust the redirect.
  if (query.get('client_id') !== CLIENT_ID) {
    return platformError(response, 400, 'unauthorized_client', 'not a registered application');
  }
  if (redirectUri !== REDIRECT_URI) {
    return platformError(response, 400, 'invalid_request', 'the redirect_uri is not registered');
  }
  const fail = (error, description) =>
    redirectError(response, redirectUri, state, error, description);
  if (query.get('response_type') !== 'code') return fail('unsupported_response_type', 'code');
  if (!(query.get('scope') ?? '').split(' ').includes('openid')) {
    return fail('invalid_scope', 'openid is required');
  }
  if ((query.get('response_mode') ?? 'query') !== 'query') {
    return fail('invalid_request', 'this mock answers by query');
  }
  if (state === null || query.get('nonce') === null) {
    return fail('invalid_request', 'state and nonce are required');
  }
  if (query.get('code_challenge_method') !== 'S256' || query.get('code_challenge') === null) {
    return fail('invalid_request', 'PKCE with S256 is required');
  }
  const code = `1.${randomBytes(48).toString('base64url')}`;
  codes.set(code, {
    tenant,
    redirectUri,
    challenge: query.get('code_challenge'),
    nonce: query.get('nonce'),
    person: structuredClone(person),
  });
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  back.searchParams.set('session_state', crypto.randomUUID());
  response.writeHead(302, { location: back.href });
  response.end();
}

/** An ID token for the claims the code was issued with. */
function idTokenFor(code) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: CLIENT_ID,
    iss: `${LOGIN}/${String(code.person.tid)}/v2.0`,
    iat: now,
    nbf: now,
    exp: now + 3600,
    aio: randomBytes(32).toString('base64url'),
    nonce: code.nonce,
    rh: `1.${randomBytes(24).toString('base64url')}.`,
    uti: randomBytes(16).toString('base64url'),
    ver: '2.0',
    ...code.person,
  };
  // A claim set to null is left out.
  for (const [name, value] of Object.entries(claims)) {
    if (value === null) delete claims[name];
  }
  const header = { typ: 'JWT', alg: 'RS256', kid: KID };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${input}.${sign('sha256', Buffer.from(input, 'ascii'), privateKey).toString('base64url')}`;
}

function token(tenant, request, form, response) {
  // This plugin authenticates with the secret in the body; a Basic header is not taken.
  if (request.headers.authorization !== undefined) {
    return platformError(response, 401, 'invalid_client', 'client_secret_post is expected');
  }
  if (
    !same(form.get('client_id') ?? '', CLIENT_ID) ||
    !same(form.get('client_secret') ?? '', CLIENT_SECRET)
  ) {
    return platformError(response, 401, 'invalid_client', 'invalid client secret');
  }
  if (form.get('grant_type') !== 'authorization_code') {
    return platformError(response, 400, 'unsupported_grant_type', 'authorization_code only');
  }
  const value = form.get('code') ?? '';
  const code = codes.get(value);
  codes.delete(value);
  if (code === undefined) return platformError(response, 400, 'invalid_grant', 'unknown code');
  if (code.tenant !== tenant) {
    return platformError(response, 400, 'invalid_grant', 'the code is for another tenant');
  }
  if (form.get('redirect_uri') !== code.redirectUri) {
    return platformError(response, 400, 'invalid_grant', 'redirect_uri mismatch');
  }
  if (!same(s256(form.get('code_verifier') ?? ''), code.challenge)) {
    return platformError(response, 400, 'invalid_grant', 'the code_verifier does not match');
  }
  const accessToken = `eyJ0eXAiOiJKV1Qi.${randomBytes(48).toString('base64url')}`;
  const idToken = idTokenFor(code);
  issued.accessTokens.push(accessToken);
  issued.idTokens.push(idToken);
  people.set(accessToken, code.person);
  return json(response, 200, {
    token_type: 'Bearer',
    scope: 'email openid profile https://graph.microsoft.com/User.Read',
    expires_in: 3893,
    ext_expires_in: 3893,
    access_token: accessToken,
    id_token: idToken,
  });
}

function userinfo(request, response) {
  const header = request.headers.authorization ?? '';
  const signedIn = header.startsWith('Bearer ')
    ? people.get(header.slice('Bearer '.length))
    : undefined;
  if (signedIn === undefined) {
    return json(response, 401, { error: { code: 'InvalidAuthenticationToken' } });
  }
  return json(response, 200, {
    sub: signedIn.sub,
    name: signedIn.name,
    family_name: signedIn.family_name,
    given_name: signedIn.given_name,
    email: signedIn.email,
  });
}

async function control(request, url, response) {
  if (request.method === 'PUT' && url.pathname === '/_control/person') {
    person = JSON.parse(await bodyOf(request));
    return json(response, 200, person);
  }
  if (request.method === 'GET' && url.pathname === '/_control/tokens') {
    return json(response, 200, issued);
  }
  if (request.method === 'GET' && url.pathname === '/_control/calls') {
    return json(response, 200, { calls });
  }
  return json(response, 404, { error: 'not_found' });
}

/** A call to the login host: `/{tenant}/…` with a tenant the platform knows. */
function login(request, url, response, call) {
  const match = TENANT_PATH.exec(url.pathname);
  const tenant = match?.[1];
  const rest = match?.[2];
  if (tenant === undefined || !(TENANT_ID.test(tenant) || MULTI_TENANT.has(tenant))) {
    return platformError(response, 400, 'invalid_tenant', 'the tenant is not valid');
  }
  if (request.method === 'GET' && rest === '/v2.0/.well-known/openid-configuration') {
    return json(response, 200, discovery(tenant));
  }
  if (request.method === 'GET' && rest === '/discovery/v2.0/keys') return keys(tenant, response);
  if (request.method === 'GET' && rest === '/oauth2/v2.0/authorize') {
    return authorize(tenant, url, response);
  }
  if (request.method === 'POST' && rest === '/oauth2/v2.0/token') {
    bodyOf(request)
      .then((text) => {
        const form = new URLSearchParams(text);
        // Which members the request sent, never their values.
        call.form = [...new Set(form.keys())].sort();
        token(tenant, request, form, response);
      })
      .catch(() => platformError(response, 400, 'invalid_request', 'bad request'));
    return;
  }
  return platformError(response, 404, 'not_found', 'no such endpoint');
}

const tls = {
  key: readFileSync(process.env.TLS_KEY ?? '/certs/mock.key'),
  cert: readFileSync(process.env.TLS_CERT ?? '/certs/mock.crt'),
};

createServer(tls, (request, response) => {
  const url = new URL(request.url ?? '/', LOGIN);
  if (url.pathname.startsWith('/_control/')) {
    control(request, url, response).catch(() => json(response, 400, { error: 'bad control call' }));
    return;
  }
  const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const call = {
    method: request.method,
    host,
    path: url.pathname,
    authorization: request.headers.authorization !== undefined,
  };
  calls.push(call);
  if (host === GRAPH_HOST) {
    if (request.method === 'GET' && url.pathname === '/oidc/userinfo') {
      return userinfo(request, response);
    }
    return json(response, 404, { error: { code: 'NotFound' } });
  }
  // The login host, under its own name or, for the browser on the host, localhost.
  return login(request, url, response, call);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mock identity platform listening on ${String(PORT)}`);
});
