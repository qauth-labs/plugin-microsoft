/**
 * `@qauth-labs/plugin-microsoft` — sign in with Microsoft for QAuth, as an
 * upstream OpenID Connect preset. EXPERIMENTAL, like the plugin API it is
 * written against.
 *
 * The operator installs the package with the deployment, lists it in
 * `AUTH_METHOD_PLUGINS` and turns on `PLUGIN_API_ENABLED`; the server builds
 * the sign-in method from `upstreamOidcPreset` on its own OpenID Connect
 * client, and each realm then configures and enables it through the admin
 * API. See the README.
 *
 * @packageDocumentation
 */
export {
  isMicrosoftMultiTenant,
  MAX_MICROSOFT_CLIENT_ID_LENGTH,
  MAX_MICROSOFT_CLIENT_SECRET_LENGTH,
  MICROSOFT_ATTRIBUTES,
  MICROSOFT_GRAPH_ORIGIN,
  MICROSOFT_ISSUER_TEMPLATE,
  MICROSOFT_LOGIN_ORIGIN,
  MICROSOFT_MULTI_TENANT_ENDPOINTS,
  MICROSOFT_ORIGINS,
  MICROSOFT_PLUGIN_ID,
  MICROSOFT_PLUGIN_TYPE,
  MICROSOFT_SCOPES,
  MICROSOFT_TENANT_CLAIM,
  MICROSOFT_TENANT_ID_PATTERN,
  type MicrosoftConfig,
  microsoftConfigSchema,
  microsoftIssuer,
  type MicrosoftMultiTenantEndpoint,
  microsoftRedirectUri,
  upstreamOidcPreset,
} from './microsoft.js';
