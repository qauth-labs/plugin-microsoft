import {
  authMethodRoutePrefix,
  defineUpstreamOidcPreset,
  UPSTREAM_TENANT_PLACEHOLDER,
  type UpstreamClaimAttribute,
  upstreamClaimIsTrue,
  type UpstreamOidcProviderConfig,
} from '@qauth-labs/plugin-sdk';
import { z } from 'zod';

/**
 * Sign in with Microsoft: an upstream OpenID Connect preset for the Microsoft
 * identity platform's v2.0 endpoints (Microsoft Entra ID). The preset holds
 * the platform's facts and its claim rules; QAuth's own OpenID Connect client
 * runs the protocol (discovery, PKCE with S256, `state` and `nonce`, the ID
 * token and key set checks, the token request). A realm's admin sets the app
 * registration's client id and secret and the tenant to sign in through:
 *
 * - **a tenant id** (a GUID, in lower case): only that tenant's accounts sign
 *   in. The issuer is `https://login.microsoftonline.com/<tenant id>/v2.0`,
 *   and an ID token any other tenant issued is refused;
 * - **`organizations`** or **`common`**: the multi-tenant endpoints, through
 *   which work or school accounts of any tenant (and, for `common`, personal
 *   accounts) sign in. Their discovery document names the issuer template
 *   `https://login.microsoftonline.com/{tenantid}/v2.0`, and an ID token is
 *   accepted only when its `iss` is the template with the token's own `tid`
 *   in place.
 *
 * EXPERIMENTAL, like the plugin API it is written against.
 *
 * @packageDocumentation
 */

/** The plugin's AuthMethod id: its name in the admin API. */
export const MICROSOFT_PLUGIN_ID = 'microsoft';

/** The plugin's AuthMethod type: its callback is `/upstream/microsoft/callback`. */
export const MICROSOFT_PLUGIN_TYPE = 'microsoft';

/** The origin of the Microsoft identity platform's endpoints. */
export const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';

/** The origin of Microsoft Graph, which serves the platform's userinfo endpoint. */
export const MICROSOFT_GRAPH_ORIGIN = 'https://graph.microsoft.com';

/**
 * The origins the provider answers on: the login endpoints (the issuer, the
 * authorization and token endpoints, the key set) and Microsoft Graph, where
 * the discovery document puts the userinfo endpoint. Every URL the server's
 * client calls, the discovered ones included, must be on one of them, so the
 * client secret reaches no other host.
 */
export const MICROSOFT_ORIGINS: readonly string[] = Object.freeze([
  MICROSOFT_LOGIN_ORIGIN,
  MICROSOFT_GRAPH_ORIGIN,
]);

/** The multi-tenant endpoints the config may name in place of a tenant id. */
export const MICROSOFT_MULTI_TENANT_ENDPOINTS = Object.freeze(['common', 'organizations'] as const);

/** A multi-tenant endpoint the config may name. */
export type MicrosoftMultiTenantEndpoint = (typeof MICROSOFT_MULTI_TENANT_ENDPOINTS)[number];

/** A tenant id, as the v2.0 issuer spells it: a GUID in lower case. */
export const MICROSOFT_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The issuer template of the multi-tenant endpoints. */
export const MICROSOFT_ISSUER_TEMPLATE = `${MICROSOFT_LOGIN_ORIGIN}/${UPSTREAM_TENANT_PLACEHOLDER}/v2.0`;

/** The ID token claim that names the account's tenant. */
export const MICROSOFT_TENANT_CLAIM = 'tid';

/** The scopes the plugin asks for. */
export const MICROSOFT_SCOPES: readonly string[] = Object.freeze(['openid', 'email', 'profile']);

/** The longest application (client) id the config takes. */
export const MAX_MICROSOFT_CLIENT_ID_LENGTH = 255;

/** The longest client secret the config takes. */
export const MAX_MICROSOFT_CLIENT_SECRET_LENGTH = 1024;

/** The v2.0 issuer of a tenant id, or the discovery base of a multi-tenant endpoint. */
export function microsoftIssuer(tenant: string): string {
  return `${MICROSOFT_LOGIN_ORIGIN}/${tenant}/v2.0`;
}

/** The plugin's config for one realm: the application's registration and the tenant. */
export const microsoftConfigSchema = z.strictObject({
  /**
   * The tenant id (a lower-case GUID) whose accounts sign in, or a
   * multi-tenant endpoint: `organizations` (work or school accounts of any
   * tenant) or `common` (those and personal accounts). A domain name is not
   * taken: the v2.0 issuer names the tenant id, which the server compares.
   */
  tenant: z.union([
    z.enum(MICROSOFT_MULTI_TENANT_ENDPOINTS),
    z.string().regex(MICROSOFT_TENANT_ID_PATTERN),
  ]),
  /** The application (client) id of the app registration. */
  clientId: z.string().min(1).max(MAX_MICROSOFT_CLIENT_ID_LENGTH),
  /** A client secret of the app registration: write-only, stored encrypted. */
  clientSecret: z.string().min(1).max(MAX_MICROSOFT_CLIENT_SECRET_LENGTH).meta({ writeOnly: true }),
});

/** The plugin's config, parsed. */
export type MicrosoftConfig = z.output<typeof microsoftConfigSchema>;

/**
 * The attributes a Microsoft sign-in maps to. `email` is verified only when
 * the ID token carries `xms_edov` (email domain owner verified) as the
 * boolean `true`, an optional claim the app registration must ask for: the
 * `email` claim alone is a property of the account that its tenant's admins
 * may set to any address, so it is unverified by default. `email_verified` is
 * not read. `preferred_username` and `tid` (the account's tenant) are kept,
 * never verified.
 */
export const MICROSOFT_ATTRIBUTES: readonly UpstreamClaimAttribute[] = Object.freeze([
  { claim: 'email', verified: (claims) => upstreamClaimIsTrue(claims, 'xms_edov') },
  { claim: 'name' },
  { claim: 'given_name' },
  { claim: 'family_name' },
  { claim: 'preferred_username' },
  { claim: MICROSOFT_TENANT_CLAIM },
]);

/** Whether the config names a multi-tenant endpoint. */
export function isMicrosoftMultiTenant(tenant: string): tenant is MicrosoftMultiTenantEndpoint {
  return (MICROSOFT_MULTI_TENANT_ENDPOINTS as readonly string[]).includes(tenant);
}

/**
 * The server's provider config for a parsed config: the tenant's v2.0 issuer,
 * read by discovery, and for a multi-tenant endpoint its issuer template; the
 * client secret in the token request's body (`client_secret_post`); ID tokens
 * signed with RS256, as the platform signs them. Changing the tenant changes
 * the issuer, where the server binds the stored client secret, so the admin
 * API asks for the secret again.
 */
function microsoftUpstreamConfig(config: MicrosoftConfig): UpstreamOidcProviderConfig {
  return {
    issuer: microsoftIssuer(config.tenant),
    ...(isMicrosoftMultiTenant(config.tenant)
      ? {
          tenantIssuer: {
            template: MICROSOFT_ISSUER_TEMPLATE,
            tenantClaim: MICROSOFT_TENANT_CLAIM,
          },
        }
      : {}),
    clientId: config.clientId,
    clientAuthentication: { method: 'client_secret_post', clientSecret: config.clientSecret },
    scopes: [...MICROSOFT_SCOPES],
    idTokenSigningAlgorithms: ['RS256'],
  };
}

/**
 * The preset, as QAuth's plugin loader imports it: the server builds the
 * sign-in method from it on its own OpenID Connect client.
 *
 * The sign-in page shows the provider's name, `Microsoft`, and no logo: the
 * provider changes its brand assets, and a copy here would go stale.
 *
 * @experimental
 */
export const upstreamOidcPreset = defineUpstreamOidcPreset<MicrosoftConfig>({
  id: MICROSOFT_PLUGIN_ID,
  type: MICROSOFT_PLUGIN_TYPE,
  display: { name: 'Microsoft' },
  origins: MICROSOFT_ORIGINS,
  configSchema: microsoftConfigSchema,
  upstreamConfig: microsoftUpstreamConfig,
  attributes: MICROSOFT_ATTRIBUTES,
});

/**
 * The redirect URI to register for the app registration, for a realm served
 * at `realmOrigin`: `<realm origin>/upstream/microsoft/callback`.
 *
 * @throws TypeError when `realmOrigin` is not a bare `http` or `https` origin
 */
export function microsoftRedirectUri(realmOrigin: string): string {
  let url: URL | undefined;
  try {
    url = new URL(realmOrigin);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== realmOrigin
  ) {
    throw new TypeError('realmOrigin must be a bare origin, such as https://auth.example.com');
  }
  return `${url.origin}${authMethodRoutePrefix(MICROSOFT_PLUGIN_TYPE)}/callback`;
}
