/**
 * The plugin end to end, where an operator runs it: QAuth's server image with
 * the plugin installed on top (e2e/Dockerfile), against a mock of the
 * Microsoft identity platform that answers as the platform's own hosts. The
 * server builds the sign-in method from the plugin's preset on its own OpenID
 * Connect client. The suite configures the plugin through the admin API, as
 * an operator does, and signs in through the server's own pages, as a
 * browser does.
 *
 * Run it through e2e/run.sh.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  Admin,
  browse,
  CookieJar,
  databaseDump,
  formsOf,
  issuedTokens,
  linkWithClass,
  literal,
  logsOf,
  MOCK,
  type MockCall,
  mockCalls,
  mockClient,
  type MockPerson,
  setPerson,
  sql,
} from './harness.js';

/** Where the test application wants the code; nothing listens there. */
const REDIRECT_URI = 'http://127.0.0.1:9/plugin-microsoft-e2e/callback';
/** The callback this provider alone uses. */
const CALLBACK = 'http://localhost:3000/upstream/microsoft/callback';
/** The identity platform's login host, as the server reaches it. */
const LOGIN_HOST = 'login.microsoftonline.com';
const LOGIN = `https://${LOGIN_HOST}`;
const GRAPH_HOST = 'graph.microsoft.com';

/** The v2.0 issuer of a tenant, or the base of a multi-tenant endpoint. */
const issuerOf = (tenant: string) => `${LOGIN}/${tenant}/v2.0`;

/** The tenant the realm is configured for first. */
const TENANT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
/** Another work or school tenant. */
const OTHER_TENANT = '9122040d-6c67-4c5b-b112-36a304b66dad';
/** The tenant of personal accounts, which the `common` endpoint serves too. */
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const SIGN_IN_FAILED = 'urn:qauth:event:user.sign_in_failed:v1-rc.0';
const REGISTERED = 'urn:qauth:event:user.registered:v1-rc.0';
const ERROR_PAGE = 'We could not sign you in';

let admin: Admin;
let clientId: string;
let realmId: string;

function isRedirect(response: Response): boolean {
  return response.status === 302 || response.status === 303;
}

/** A subject as the platform makes one: 43 characters, unique to the app. */
function subject(): string {
  return `AAAAAAAAAAAAAAAAAAAAA${randomBytes(16).toString('base64url')}`;
}

/** A person of `tenant`, with a subject of their own. */
function personOf(tenant: string, claims: Record<string, unknown> = {}): MockPerson {
  return {
    sub: subject(),
    oid: crypto.randomUUID(),
    tid: tenant,
    name: 'Ada Lovelace',
    given_name: 'Ada',
    family_name: 'Lovelace',
    preferred_username: 'ada@contoso.example',
    email: 'ada@contoso.example',
    ...claims,
  };
}

/** The realm's state of the plugin, as the admin API reads it. */
async function pluginState(): Promise<Record<string, unknown>> {
  const state = await admin.call('GET', '/plugins/microsoft');
  expect(state.status).toBe(200);
  return state.body;
}

/**
 * A configure of the plugin with `config`, its client secret sealed again
 * (`seal`) or kept as stored (`keep`), filed and approved as a security
 * operation: the server's answer, at the approval when it refuses it there,
 * else at the configure.
 */
async function configureWith(
  config: Record<string, unknown>,
  secret: 'seal' | 'keep'
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body: Record<string, unknown> = { version: (await pluginState())['version'], config };
  if (secret === 'seal') {
    const sealed = await admin.sealClientSecret(mockClient().clientSecret);
    expect(sealed.status).toBe(200);
    body['secrets'] = { clientSecret: { sealed: sealed.sealed } };
  }
  const filed = await admin.file('plugins.update', body);
  if (filed.status !== 201) return filed;
  admin.approve(String(filed.body['id']));
  return admin.call('POST', '/plugins/microsoft/config', body, {
    'qauth-approval': String(filed.body['id']),
  });
}

/** Configure the plugin for `tenant`, the secret sealed again, and enable it. */
async function configure(tenant: string): Promise<void> {
  const configured = await configureWith({ tenant, clientId: mockClient().clientId }, 'seal');
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  if (configured.body['enabled'] !== true) {
    const enableBody = { version: configured.body['version'] };
    const enabled = await admin.call('POST', '/plugins/microsoft/enable', enableBody, {
      'qauth-approval': await admin.approved('plugins.enable', enableBody),
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['enabled']).toBe(true);
  }
}

/** A sign-in started at the server and sent on to the identity platform. */
interface StartedSignIn {
  readonly jar: CookieJar;
  /** The platform's authorization request, as the server sent the browser there. */
  readonly providerUrl: URL;
}

/** An application asks the server to sign someone in through the plugin. */
async function startSignIn(): Promise<StartedSignIn> {
  const jar = new CookieJar();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/oauth/authorize', 'http://localhost:3000');
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    qauth_upstream: 'microsoft',
  }).toString();
  const toStart = await browse(jar, authorize);
  expect(isRedirect(toStart)).toBe(true);
  const startUrl = toStart.headers.get('location') ?? '';
  expect(startUrl).toMatch(/^\/ui\/upstream\/microsoft\/start\?/);
  const start = await browse(jar, startUrl);
  const page = await start.text();
  expect(start.status, page).toBe(200);
  const href = linkWithClass(page, 'alt-action');
  expect(href).toBeDefined();
  const providerUrl = new URL(href ?? '');
  expect(providerUrl.searchParams.get('redirect_uri')).toBe(CALLBACK);
  return { jar, providerUrl };
}

/**
 * The person signs in at the mock's authorization page; the URL the platform
 * sends the browser back to. The suite reaches the mock from the host as
 * localhost.
 */
async function atPlatform(providerUrl: URL): Promise<URL> {
  expect(providerUrl.origin).toBe(LOGIN);
  const page = new URL(providerUrl.pathname + providerUrl.search, MOCK);
  const answer = await fetch(page, { redirect: 'manual' });
  expect(isRedirect(answer), await answer.clone().text()).toBe(true);
  const back = new URL(answer.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  expect(back.searchParams.get('error')).toBeNull();
  return back;
}

/**
 * Follow the server from the callback to the application, granting consent
 * on the way when the page asks; the code the application receives.
 */
async function toApplication(jar: CookieJar, afterCallback: Response): Promise<string> {
  let response = afterCallback;
  for (let step = 0; step < 10; step += 1) {
    const location = response.headers.get('location');
    if (isRedirect(response) && location !== null) {
      const next = new URL(location, 'http://localhost:3000');
      if (next.href.startsWith(REDIRECT_URI)) {
        const code = next.searchParams.get('code');
        expect(next.searchParams.get('error')).toBeNull();
        expect(code).not.toBeNull();
        return code ?? '';
      }
      response = await browse(jar, next);
      continue;
    }
    expect(response.status, `step ${String(step)}`).toBe(200);
    const consent = formsOf(await response.text()).find(
      (form) =>
        form.action.endsWith('/ui/consent') ||
        form.buttons.some((button) => button.name === 'decision' && button.value === 'allow')
    );
    expect(consent, 'a consent form').toBeDefined();
    if (consent === undefined) break;
    const form = new URLSearchParams(consent.fields);
    form.set('decision', 'allow');
    response = await browse(jar, consent.action, { method: 'POST', form });
  }
  throw new Error('the server did not send the browser back to the application');
}

/** A whole sign-in of `person`; the provider's authorization request it went through. */
async function signIn(person: MockPerson): Promise<URL> {
  await setPerson(person);
  const { jar, providerUrl } = await startSignIn();
  const back = await atPlatform(providerUrl);
  const callback = await browse(jar, back);
  expect(isRedirect(callback), await callback.clone().text()).toBe(true);
  await toApplication(jar, callback);
  return providerUrl;
}

/** A sign-in of `person` the server refuses at its callback, with the one error page. */
async function refusedSignIn(person: MockPerson): Promise<void> {
  await setPerson(person);
  const { jar, providerUrl } = await startSignIn();
  const back = await atPlatform(providerUrl);
  const callback = await browse(jar, back);
  expect(callback.status).toBe(400);
  expect(await callback.text()).toContain(ERROR_PAGE);
  expect(callback.headers.get('location')).toBeNull();
}

/** The accounts the credential of `sub` belongs to. */
function accountsOf(sub: string): string[] {
  return sql(
    `SELECT user_id FROM user_credentials
     WHERE provider_type = 'microsoft' AND external_sub = ${literal(sub)}`
  );
}

/** The one account of `sub`. */
function accountOf(sub: string): string {
  const accounts = accountsOf(sub);
  expect(accounts).toHaveLength(1);
  return accounts[0] ?? '';
}

/** The issuer the account's credential keeps. */
function credentialIssuerOf(sub: string): string | undefined {
  return sql(
    `SELECT credential_data->>'iss' FROM user_credentials
     WHERE provider_type = 'microsoft' AND external_sub = ${literal(sub)}`
  )[0];
}

function userCount(): number {
  return Number(sql('SELECT count(*) FROM users')[0]);
}

/** The attributes the plugin wrote for an account: key, value and whether verified. */
function attributesOf(accountId: string): { key: string; value: string; verified: boolean }[] {
  return sql(
    `SELECT attr_key, attr_value, verified FROM user_attributes
     WHERE user_id = ${literal(accountId)} AND source = 'microsoft' ORDER BY attr_key`
  ).map((row) => {
    const [key = '', value = '', verified = ''] = row.split('|');
    return { key, value, verified: verified === 't' };
  });
}

function failedSignIns(reason: string): number {
  return Number(
    sql(
      `SELECT count(*) FROM events WHERE type = ${literal(SIGN_IN_FAILED)}
       AND data->>'method' = 'upstream' AND data->>'reason' = ${literal(reason)}`
    )[0]
  );
}

/** The calls the mock answered since `before`, those the server made (not the browser). */
async function serverCallsSince(before: number): Promise<MockCall[]> {
  return (await mockCalls())
    .slice(before)
    .filter((call) => call.host === LOGIN_HOST || call.host === GRAPH_HOST);
}

beforeAll(async () => {
  const [master] = sql(`SELECT id FROM realms WHERE name = 'master'`);
  if (master === undefined) throw new Error('no master realm');
  realmId = master;
  admin = await Admin.create(realmId);
  const registered = await fetch('http://localhost:3000/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plugin-microsoft e2e application',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid',
    }),
  });
  expect(registered.status).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
});

describe('the boot', () => {
  it('builds the method from the preset while PLUGIN_API_ENABLED is on', () => {
    const loaded = logsOf('auth-server')
      .split('\n')
      .filter((line) =>
        line.includes(
          'AuthMethod plugin @qauth-labs/plugin-microsoft loaded: microsoft (microsoft)'
        )
      );
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toContain('"kind":"upstream-oidc-preset"');
    expect(loaded[0]).toContain('"firstParty":false');
  });

  // Acceptance: with PLUGIN_API_ENABLED off, the server skips the plugin and the boot says why.
  it('skips the plugin with PLUGIN_API_ENABLED off, and says why', () => {
    const log = logsOf('auth-server-plugin-api-off');
    expect(log).toContain(
      'The AuthMethod plugin @qauth-labs/plugin-microsoft is not loaded: it is not a first-party plugin, and the experimental plugin API is off.'
    );
    expect(log).not.toContain('AuthMethod plugin @qauth-labs/plugin-microsoft loaded');
  });

  it('lists the plugin in the admin API, off and not configured yet', async () => {
    expect(await pluginState()).toMatchObject({
      name: 'microsoft',
      type: 'microsoft',
      package: '@qauth-labs/plugin-microsoft',
      firstParty: false,
      contract: 'qauth-auth-method/1-rc.0',
      displayName: 'Microsoft',
      enabled: false,
      secrets: [{ path: 'clientSecret', set: false }],
    });
  });
});

describe('the configuration', () => {
  it.each([
    ['a tenant id in upper case', TENANT.toUpperCase()],
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['the consumers endpoint', 'consumers'],
  ])('refuses %s as the tenant, and stores nothing', async (_case, tenant) => {
    const before = await pluginState();
    const refused = await configureWith({ tenant, clientId: mockClient().clientId }, 'seal');
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(await pluginState()).toMatchObject({
      version: before['version'],
      enabled: false,
      secrets: [{ path: 'clientSecret', set: false }],
    });
  });

  it('refuses the client secret in the clear, among the plain members', async () => {
    const { clientId: microsoftClientId, clientSecret } = mockClient();
    const refused = await configureWith(
      { tenant: TENANT, clientId: microsoftClientId, clientSecret },
      'keep'
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain(clientSecret);
    expect((await pluginState())['secrets']).toEqual([{ path: 'clientSecret', set: false }]);
  });

  it('takes the client secret only sealed, and never shows it', async () => {
    await configure(TENANT);
    const state = await pluginState();
    expect(state).toMatchObject({
      enabled: true,
      config: { tenant: TENANT, clientId: mockClient().clientId },
      secrets: [{ path: 'clientSecret', set: true }],
    });
    expect(Object.keys(state['config'] as object).sort()).toEqual(['clientId', 'tenant']);
    expect(JSON.stringify(state)).not.toContain(mockClient().clientSecret);
  });
});

describe('sign-in with a fixed tenant', () => {
  const ada = personOf(TENANT, {
    // An address verified elsewhere: never the domain's own verification.
    email_verified: true,
  });
  let account: string;

  // Acceptance: a full sign-in creates an account with the right attributes;
  // the email attribute is unverified by default.
  it("creates the account of the tenant's person, the email unverified", async () => {
    const before = userCount();
    const callsBefore = (await mockCalls()).length;
    const providerUrl = await signIn(ada);

    expect(`${providerUrl.origin}${providerUrl.pathname}`).toBe(
      `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`
    );
    expect(providerUrl.searchParams.get('scope')).toBe('openid email profile');
    expect(providerUrl.searchParams.get('code_challenge_method')).toBe('S256');
    account = accountOf(ada.sub);
    expect(userCount()).toBe(before + 1);
    // The subject, under the issuer of the tenant that named it.
    expect(credentialIssuerOf(ada.sub)).toBe(issuerOf(TENANT));
    expect(attributesOf(account)).toEqual([
      { key: 'email', value: 'ada@contoso.example', verified: false },
      { key: 'family_name', value: 'Lovelace', verified: false },
      { key: 'given_name', value: 'Ada', verified: false },
      { key: 'name', value: 'Ada Lovelace', verified: false },
      { key: 'preferred_username', value: 'ada@contoso.example', verified: false },
      { key: 'tid', value: TENANT, verified: false },
    ]);
    expect(
      sql(
        `SELECT data->>'method' FROM events
         WHERE type = ${literal(REGISTERED)} AND subject_id = ${literal(account)}`
      )
    ).toEqual(['upstream']);
    // Built from a preset on the server's own client: its attributes rank
    // with an oidc_* provider's, and every row says so.
    expect(
      sql(
        `SELECT DISTINCT provenance->>'builtFrom' FROM user_attributes
         WHERE user_id = ${literal(account)} AND source = 'microsoft'`
      )
    ).toEqual(['upstream-oidc-preset']);

    // The server read the tenant's own v2.0 endpoints, never Graph, and sent
    // the client secret in the token request's body.
    const calls = await serverCallsSince(callsBefore);
    expect(calls.every((call) => call.host === LOGIN_HOST)).toBe(true);
    expect(calls.every((call) => call.path.startsWith(`/${TENANT}/`))).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        `POST /${TENANT}/oauth2/v2.0/token`,
        `GET /${TENANT}/discovery/v2.0/keys`,
      ])
    );
    // Discovery, at this sign-in or before it, from the tenant's own document.
    expect((await serverCallsSince(0)).map((call) => call.path)).toContain(
      `/${TENANT}/v2.0/.well-known/openid-configuration`
    );
    const tokenRequest = calls.find((call) => call.method === 'POST');
    expect(tokenRequest?.authorization).toBe(false);
    expect(tokenRequest?.form).toEqual(
      expect.arrayContaining(['client_id', 'client_secret', 'code', 'code_verifier'])
    );
    expect(tokenRequest?.form).not.toContain('client_assertion');
  });

  it.each([
    [true, true],
    ['true', false],
  ])(
    'marks the email verified only when xms_edov is the boolean true (%s)',
    async (flag, verified) => {
      const person = personOf(TENANT, {
        email: `edov-${String(verified)}@contoso.example`,
        xms_edov: flag,
      });
      await signIn(person);
      expect(attributesOf(accountOf(person.sub))).toContainEqual({
        key: 'email',
        value: `edov-${String(verified)}@contoso.example`,
        verified,
      });
    }
  );

  it('signs the same person in to the same account, with a changed address and name', async () => {
    const before = userCount();
    await signIn({ ...ada, email: 'ada.king@contoso.example', name: 'Ada King' });
    expect(accountsOf(ada.sub)).toEqual([account]);
    expect(userCount()).toBe(before);
  });

  // Acceptance: a token from another tenant than the configured one is refused.
  it('refuses a token another tenant issued, and creates nothing', async () => {
    const stranger = personOf(OTHER_TENANT);
    const before = userCount();
    const refusedBefore = failedSignIns('invalid_response');

    await refusedSignIn(stranger);

    expect(failedSignIns('invalid_response')).toBe(refusedBefore + 1);
    expect(accountsOf(stranger.sub)).toEqual([]);
    expect(userCount()).toBe(before);
  });

  it('refuses a callback with a wrong state, and never redeems the code', async () => {
    await setPerson(ada);
    const mismatchesBefore = failedSignIns('transaction_mismatch');
    const tokensBefore = (await issuedTokens()).accessTokens.length;
    const { jar, providerUrl } = await startSignIn();
    const back = await atPlatform(providerUrl);
    expect(back.searchParams.get('state')).toBe(providerUrl.searchParams.get('state'));

    const forged = new URL(back);
    forged.searchParams.set('state', randomBytes(32).toString('base64url'));
    const refused = await browse(jar, forged);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(ERROR_PAGE);
    expect(failedSignIns('transaction_mismatch')).toBe(mismatchesBefore + 1);
    expect((await issuedTokens()).accessTokens).toHaveLength(tokensBefore);
  });
});

describe('a change of tenant', () => {
  it('asks for the client secret again', async () => {
    const before = await pluginState();
    const refused = await configureWith(
      { tenant: 'organizations', clientId: mockClient().clientId },
      'keep'
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('seal it again');
    expect(await pluginState()).toMatchObject({
      version: before['version'],
      config: { tenant: TENANT },
    });
  });

  it('takes the new tenant with the client secret sealed again', async () => {
    await configure('organizations');
    expect(await pluginState()).toMatchObject({
      enabled: true,
      config: { tenant: 'organizations' },
      secrets: [{ path: 'clientSecret', set: true }],
    });
  });
});

describe('sign-in through the organizations endpoint', () => {
  const grace = personOf(OTHER_TENANT, {
    name: 'Grace Hopper',
    given_name: 'Grace',
    family_name: 'Hopper',
    preferred_username: 'grace@fabrikam.example',
    email: 'grace@fabrikam.example',
  });

  // Acceptance: a multi-tenant token whose issuer matches the template is accepted.
  it("accepts a token whose issuer is the template with the token's own tid", async () => {
    const callsBefore = (await mockCalls()).length;
    const providerUrl = await signIn(grace);

    expect(`${providerUrl.origin}${providerUrl.pathname}`).toBe(
      `${LOGIN}/organizations/oauth2/v2.0/authorize`
    );
    const account = accountOf(grace.sub);
    expect(credentialIssuerOf(grace.sub)).toBe(issuerOf(OTHER_TENANT));
    expect(attributesOf(account)).toContainEqual({
      key: 'tid',
      value: OTHER_TENANT,
      verified: false,
    });
    expect(attributesOf(account)).toContainEqual({
      key: 'email',
      value: 'grace@fabrikam.example',
      verified: false,
    });
    expect((await serverCallsSince(callsBefore)).map((call) => call.path)).toContain(
      '/organizations/oauth2/v2.0/token'
    );
    expect((await serverCallsSince(0)).map((call) => call.path)).toContain(
      '/organizations/v2.0/.well-known/openid-configuration'
    );
  });

  it.each([
    ['names another tenant than its tid', { tid: OTHER_TENANT, iss: issuerOf(TENANT) }],
    ['is the multi-tenant endpoint', { tid: TENANT, iss: issuerOf('organizations') }],
    ['is the template itself', { tid: TENANT, iss: issuerOf('{tenantid}') }],
    ['comes with no tid', { tid: null, iss: issuerOf(TENANT) }],
    ['is on another host', { tid: TENANT, iss: `https://login.example.com/${TENANT}/v2.0` }],
  ])('refuses a token whose issuer %s, and creates nothing', async (_case, claims) => {
    const person = personOf(TENANT, claims);
    const before = userCount();
    const refusedBefore = failedSignIns('invalid_response');

    await refusedSignIn(person);

    expect(failedSignIns('invalid_response')).toBe(refusedBefore + 1);
    expect(accountsOf(person.sub)).toEqual([]);
    expect(userCount()).toBe(before);
  });

  it("refuses the same subject from another tenant than its account's", async () => {
    const before = userCount();
    const refusedBefore = failedSignIns('issuer_mismatch');

    await refusedSignIn({ ...grace, tid: TENANT });

    expect(failedSignIns('issuer_mismatch')).toBe(refusedBefore + 1);
    expect(credentialIssuerOf(grace.sub)).toBe(issuerOf(OTHER_TENANT));
    expect(userCount()).toBe(before);
  });
});

describe('sign-in through the common endpoint', () => {
  it('accepts a personal account, under its own tenant', async () => {
    await configure('common');
    const personal = personOf(CONSUMER_TENANT, {
      preferred_username: 'ada@outlook.example',
      email: 'ada@outlook.example',
    });
    const providerUrl = await signIn(personal);

    expect(`${providerUrl.origin}${providerUrl.pathname}`).toBe(
      `${LOGIN}/common/oauth2/v2.0/authorize`
    );
    expect(credentialIssuerOf(personal.sub)).toBe(issuerOf(CONSUMER_TENANT));
    expect(attributesOf(accountOf(personal.sub))).toContainEqual({
      key: 'tid',
      value: CONSUMER_TENANT,
      verified: false,
    });
  });
});

describe('the tokens and the client secret', () => {
  it('are not in the database, the logs or the events', async () => {
    const { accessTokens, idTokens } = await issuedTokens();
    // One of each per completed or refused sign-in above that reached the token endpoint.
    expect(accessTokens.length).toBeGreaterThanOrEqual(6);
    expect(idTokens).toHaveLength(accessTokens.length);

    const dump = databaseDump();
    const events = sql('SELECT row_to_json(events)::text FROM events').join('\n');
    const logs = [logsOf('auth-server'), logsOf('auth-server-plugin-api-off')].join('\n');
    expect(events).toContain(REGISTERED);
    for (const token of [...accessTokens, ...idTokens]) {
      expect(dump.includes(token), 'a token in the database').toBe(false);
      expect(events.includes(token), 'a token in the events').toBe(false);
      expect(logs.includes(token), 'a token in the logs').toBe(false);
    }
    // Nor is the client secret, which the server keeps sealed.
    const { clientSecret } = mockClient();
    expect(dump.includes(clientSecret), 'the client secret in the database').toBe(false);
    expect(events.includes(clientSecret), 'the client secret in the events').toBe(false);
    expect(logs.includes(clientSecret), 'the client secret in the logs').toBe(false);
  });
});
