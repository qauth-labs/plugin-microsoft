# Changelog

All notable changes to `@qauth-labs/plugin-microsoft` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

The first version, not released yet. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

Two of its dependencies are temporary, and both go before the first release
candidate (RELEASING.md): the plugin SDK is the tarball in `vendor/`, until
the SDK release that carries qauth-labs/qauth#671 is on npm; and the
end-to-end suite builds QAuth's server and migration-runner images from the
qauth commit `e2e/qauth-commit` names, until a released image carries the
preset loader.

### Added

- Sign in with Microsoft (the Microsoft identity platform's v2.0 endpoints,
  Microsoft Entra ID) as a QAuth upstream OpenID Connect preset: the package
  exports `upstreamOidcPreset`, and QAuth's own OpenID Connect client runs the
  protocol (discovery, PKCE with S256, `state` and `nonce`, the ID token and
  key set checks). It depends only on `@qauth-labs/plugin-sdk`, with `zod` as
  a peer, and holds no key.
- A fixed tenant, given as a lower-case tenant id: only that tenant's tokens
  are accepted. Or the multi-tenant `organizations` and `common` endpoints: a
  token is accepted only when its `iss` is
  `https://login.microsoftonline.com/{tenantid}/v2.0` with the token's own
  `tid` in place. A domain name and `consumers` are not taken as the tenant.
- The config: `tenant`, `clientId` and a write-only `clientSecret`, which the
  server stores encrypted and never shows, and sends in the token request's
  body. A change of tenant changes the issuer the secret is bound to, so the
  admin API asks for the secret again.
- The attributes `email`, `name`, `given_name`, `family_name`,
  `preferred_username` and `tid`. The email is verified only when the ID token
  carries `xms_edov` as the boolean `true`; nothing else is ever verified.
- Calls go only to `login.microsoftonline.com` and `graph.microsoft.com`,
  through the egress client QAuth hands the plugin.
- The sign-in page shows the provider's name, with no logo.
- CI with the plugin SDK's preset kit, and an end-to-end suite that runs the
  QAuth server image with the plugin installed against a mock of the
  identity platform.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA.

[Unreleased]: https://github.com/qauth-labs/plugin-microsoft/commits/main
