/**
 * The preset, as far as it can be checked without QAuth's server: the SDK's
 * preset kit (`checkUpstreamOidcPreset`) on a config of each shape, the config
 * schema and its write-only secret, the provider config each config makes,
 * and the attribute rules on sample claims.
 *
 * What only the server's OpenID Connect client decides (the tenant a token
 * names, its issuer, the secret asked for again when the tenant changes, how
 * the attributes rank) is the end-to-end suite's (e2e/), against the server
 * image with the plugin installed and a mock of the identity platform.
 */
import {
  AUTH_METHOD_CONTRACT,
  AUTH_METHOD_PLUGIN_EXPORT,
  isUpstreamOidcPreset,
  UPSTREAM_OIDC_PRESET_EXPORT,
} from '@qauth-labs/plugin-sdk';
import { checkUpstreamOidcPreset } from '@qauth-labs/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as plugin from '../src/index.js';
import {
  MICROSOFT_ATTRIBUTES,
  MICROSOFT_ISSUER_TEMPLATE,
  microsoftConfigSchema,
  microsoftIssuer,
  microsoftRedirectUri,
  upstreamOidcPreset,
} from '../src/index.js';

const CLIENT_ID = '6731de76-14a6-49ae-97bc-6eba6914391e';
const CLIENT_SECRET = 'a-microsoft-client-secret-of-some-length';
const TENANT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
const OTHER_TENANT = '9122040d-6c67-4c5b-b112-36a304b66dad';

const configFor = (tenant: string) => ({
  tenant,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

/** The provider config the preset makes for a config the schema parsed. */
const providerConfigFor = (tenant: string) =>
  upstreamOidcPreset.upstreamConfig(microsoftConfigSchema.parse(configFor(tenant)));

/** Whether the email rule marks `claims`'s address verified. */
function emailVerified(claims: Record<string, unknown>): boolean {
  const rule = MICROSOFT_ATTRIBUTES.find((attribute) => attribute.claim === 'email');
  return rule?.verified?.(claims) === true;
}

describe('the package', () => {
  it('exports its preset as upstreamOidcPreset, and no authMethod', () => {
    expect(UPSTREAM_OIDC_PRESET_EXPORT in plugin).toBe(true);
    expect(AUTH_METHOD_PLUGIN_EXPORT in plugin).toBe(false);
    expect(isUpstreamOidcPreset(plugin.upstreamOidcPreset)).toBe(true);
  });

  it('is written against the SDK’s contract, frozen', () => {
    expect(upstreamOidcPreset.contract).toBe(AUTH_METHOD_CONTRACT);
    expect(Object.isFrozen(upstreamOidcPreset)).toBe(true);
    expect(Object.isFrozen(upstreamOidcPreset.origins)).toBe(true);
  });

  it('is the microsoft method, shown by its name and no logo', () => {
    expect(upstreamOidcPreset).toMatchObject({ id: 'microsoft', type: 'microsoft' });
    expect(upstreamOidcPreset.display).toEqual({ name: 'Microsoft' });
  });

  it('names the identity platform and Microsoft Graph as its only origins', () => {
    expect(upstreamOidcPreset.origins).toEqual([
      'https://login.microsoftonline.com',
      'https://graph.microsoft.com',
    ]);
  });

  it('reads no response member and sets no claim of its own', () => {
    expect(upstreamOidcPreset.responseMembers).toBeUndefined();
    expect(upstreamOidcPreset.identityClaims).toBeUndefined();
  });
});

describe('the preset kit', () => {
  // Acceptance: the contract kit passes.
  it('passes for a fixed tenant and for both multi-tenant endpoints', () => {
    const report = checkUpstreamOidcPreset(upstreamOidcPreset, {
      configs: [configFor(TENANT), configFor('organizations'), configFor('common')],
    });
    expect(report.checks).toEqual([
      'static',
      'config-schema',
      'upstream-config',
      'secret',
      'response-members',
      'identity-claims',
    ]);
  });

  it('would refuse it with the issuer off its origins', () => {
    const offOrigins = {
      ...upstreamOidcPreset,
      origins: ['https://graph.microsoft.com'],
    };
    expect(() =>
      checkUpstreamOidcPreset(offOrigins, { configs: [configFor(TENANT)] })
    ).toThrowError(/issuer is off the preset's origins/);
  });
});

describe('the config', () => {
  it.each([TENANT, OTHER_TENANT, 'organizations', 'common'])('takes the tenant %s', (tenant) => {
    expect(microsoftConfigSchema.safeParse(configFor(tenant)).success).toBe(true);
  });

  it.each([
    ['consumers', 'consumers'],
    ['a tenant id in upper case', TENANT.toUpperCase()],
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['a path', `${TENANT}/x`],
    ['a tenant id with braces', `{${TENANT}}`],
    ['the empty string', ''],
  ])('refuses %s as the tenant', (_case, tenant) => {
    expect(microsoftConfigSchema.safeParse(configFor(tenant)).success).toBe(false);
  });

  it.each([
    ['no tenant', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
    ['an empty client id', { ...configFor(TENANT), clientId: '' }],
    ['a client id over 255 characters', { ...configFor(TENANT), clientId: 'c'.repeat(256) }],
    ['no client secret', { tenant: TENANT, clientId: CLIENT_ID }],
    ['an empty client secret', { ...configFor(TENANT), clientSecret: '' }],
    [
      'a client secret over 1024 characters',
      { ...configFor(TENANT), clientSecret: 's'.repeat(1025) },
    ],
    ['a member it does not know', { ...configFor(TENANT), issuer: 'https://idp.example.com' }],
  ])('refuses a config with %s', (_case, config) => {
    expect(microsoftConfigSchema.safeParse(config).success).toBe(false);
  });

  it('marks the client secret write-only, and nothing else', () => {
    const schema = z.toJSONSchema(microsoftConfigSchema) as {
      properties: Record<string, { writeOnly?: boolean }>;
      required: string[];
    };
    expect(schema.properties['clientSecret']?.writeOnly).toBe(true);
    expect(schema.properties['tenant']?.writeOnly).toBeUndefined();
    expect(schema.properties['clientId']?.writeOnly).toBeUndefined();
    expect([...schema.required].sort()).toEqual(['clientId', 'clientSecret', 'tenant']);
  });
});

describe('the provider config', () => {
  it("reads a fixed tenant's own v2.0 issuer by discovery, without an issuer template", () => {
    expect(providerConfigFor(TENANT)).toEqual({
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      clientId: CLIENT_ID,
      clientAuthentication: { method: 'client_secret_post', clientSecret: CLIENT_SECRET },
      scopes: ['openid', 'email', 'profile'],
      idTokenSigningAlgorithms: ['RS256'],
    });
  });

  it.each(['organizations', 'common'])(
    'reads %s by discovery, with the issuer template bound to the token’s tid',
    (endpoint) => {
      expect(providerConfigFor(endpoint)).toEqual({
        issuer: `https://login.microsoftonline.com/${endpoint}/v2.0`,
        tenantIssuer: {
          template: 'https://login.microsoftonline.com/{tenantid}/v2.0',
          tenantClaim: 'tid',
        },
        clientId: CLIENT_ID,
        clientAuthentication: { method: 'client_secret_post', clientSecret: CLIENT_SECRET },
        scopes: ['openid', 'email', 'profile'],
        idTokenSigningAlgorithms: ['RS256'],
      });
    }
  );

  it('names another issuer for each tenant, where the server binds the client secret', () => {
    const issuers = [TENANT, OTHER_TENANT, 'organizations', 'common'].map(
      (tenant) => providerConfigFor(tenant).issuer
    );
    expect(new Set(issuers).size).toBe(issuers.length);
  });

  it('reads no userinfo, sets no endpoint by hand and answers by query', () => {
    const config = providerConfigFor('organizations');
    expect(config.fetchUserinfo).toBeUndefined();
    expect(config.endpoints).toBeUndefined();
    expect(config.responseMode).toBeUndefined();
  });

  it('builds the template from the v2.0 issuer', () => {
    expect(MICROSOFT_ISSUER_TEMPLATE).toBe(microsoftIssuer('{tenantid}'));
  });
});

describe('the attributes', () => {
  it('maps the profile claims and the tenant, under their own names', () => {
    expect(MICROSOFT_ATTRIBUTES.map((rule) => [rule.claim, rule.attribute ?? rule.claim])).toEqual([
      ['email', 'email'],
      ['name', 'name'],
      ['given_name', 'given_name'],
      ['family_name', 'family_name'],
      ['preferred_username', 'preferred_username'],
      ['tid', 'tid'],
    ]);
  });

  it('never marks anything but the email verified', () => {
    expect(
      MICROSOFT_ATTRIBUTES.filter((rule) => rule.verified !== undefined).map((rule) => rule.claim)
    ).toEqual(['email']);
  });

  // Acceptance: the email attribute is unverified by default.
  it('keeps the email unverified by default, even beside email_verified', () => {
    expect(emailVerified({ email: 'ada@contoso.example' })).toBe(false);
    expect(emailVerified({ email: 'ada@contoso.example', email_verified: true })).toBe(false);
  });

  it.each([
    [true, true],
    ['true', false],
    [1, false],
    [false, false],
    [null, false],
  ])('marks the email verified only when xms_edov is the boolean true (%s)', (flag, verified) => {
    expect(emailVerified({ email: 'ada@contoso.example', xms_edov: flag })).toBe(verified);
  });

  it('does not take an xms_edov the claims only inherit', () => {
    const inherited = Object.create({ xms_edov: true }) as Record<string, unknown>;
    inherited['email'] = 'ada@contoso.example';
    expect(emailVerified(inherited)).toBe(false);
  });
});

describe('the redirect URI', () => {
  it('is the realm origin with the callback this provider alone uses', () => {
    expect(microsoftRedirectUri('https://auth.example.com')).toBe(
      'https://auth.example.com/upstream/microsoft/callback'
    );
    expect(microsoftRedirectUri('http://localhost:3000')).toBe(
      'http://localhost:3000/upstream/microsoft/callback'
    );
  });

  it.each([
    'https://auth.example.com/',
    'https://auth.example.com/realm',
    'auth.example.com',
    'ftp://auth.example.com',
  ])('refuses %s, which is not a bare origin', (origin) => {
    expect(() => microsoftRedirectUri(origin)).toThrowError(TypeError);
  });
});
