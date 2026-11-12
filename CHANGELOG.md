# Changelog

All notable changes to `@qauth-labs/plugin-microsoft` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-11-12

The first release, on npm's `latest` dist-tag. Experimental: QAuth loads it
only with `PLUGIN_API_ENABLED=true`, and its plugin API may change before
QAuth 1.0.

### Changed

- Nothing but the version: the code, the plugin SDK (`0.2.3`), the
  AuthMethod contract (`qauth-auth-method/1-rc.0`) and the end-to-end
  suite's QAuth `0.2.3` images are those of `0.1.0-rc.0`.

## [0.1.0-rc.0]

The first release candidate. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

### Added

- Sign in with Microsoft (the Microsoft identity platform's v2.0 endpoints,
  Microsoft Entra ID) as a QAuth upstream OpenID Connect preset (contract
  `qauth-auth-method/1-rc.0`), for QAuth 0.2.3 and later on the 0.2 line: the
  package exports `upstreamOidcPreset`, and QAuth's own OpenID Connect client
  runs the protocol (discovery, PKCE with S256, `state` and `nonce`, the ID
  token and key set checks). It depends only on `@qauth-labs/plugin-sdk`
  `0.2.3`, with `zod` as a peer, and holds no key.
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
  released QAuth server image with the plugin installed, against a mock of
  the identity platform.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA.

[Unreleased]: https://github.com/qauth-labs/plugin-microsoft/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qauth-labs/plugin-microsoft/compare/v0.1.0-rc.0...v0.1.0
[0.1.0-rc.0]: https://github.com/qauth-labs/plugin-microsoft/releases/tag/v0.1.0-rc.0
