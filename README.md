# @qauth-labs/plugin-microsoft

> **Experimental.** This plugin runs on QAuth's experimental plugin API. QAuth
> loads it only while `PLUGIN_API_ENABLED=true`, and the API, the contract and
> this package may change before QAuth 1.0. Do not rely on it for production
> sign-in yet.

Sign in with Microsoft for [QAuth](https://github.com/qauth-labs/qauth): the
Microsoft identity platform's v2.0 endpoints (Microsoft Entra ID), as an
upstream OpenID Connect preset. A realm that enables it offers "Microsoft" as
an upstream sign-in: the person signs in with their work, school or personal
Microsoft account, and QAuth signs them into the account that belongs to that
identity. Applications keep receiving QAuth's own OAuth 2.1 and OpenID Connect
tokens.

The plugin is made and released by the QAuth project, in its own repository,
the way a third party writes a plugin: it depends only on the published
[`@qauth-labs/plugin-sdk`](https://www.npmjs.com/package/@qauth-labs/plugin-sdk)
and has its own version line.

## Compatibility

| Plugin       | QAuth server               | AuthMethod contract        | Plugin SDK |
| ------------ | -------------------------- | -------------------------- | ---------- |
| `0.1.0`      | `0.2.3` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.3`    |
| `0.1.0-rc.0` | `0.2.3` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.3`    |

## How it signs a person in

The plugin is a **preset**: it holds the identity platform's facts (its
issuer, its origins, how QAuth authenticates to it) and its claim rules, and
nothing of the protocol. The package exports `upstreamOidcPreset`, and QAuth's
server builds the sign-in method from it on its own OpenID Connect client:
discovery, PKCE with S256, `state` and `nonce`, the token request, and the ID
token and key set checks are the server's. A fix to that code reaches this
plugin with a server release.

| What                  | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| AuthMethod id, type   | `microsoft`, `microsoft`                                            |
| Issuer                | `https://login.microsoftonline.com/<tenant>/v2.0`, by discovery     |
| Scopes                | `openid email profile`                                              |
| Client authentication | `client_secret_post`: the client secret in the token request's body |
| ID token algorithms   | `RS256`                                                             |
| Origins it calls      | `https://login.microsoftonline.com`, `https://graph.microsoft.com`  |
| Redirect URI          | `https://<realm host>/upstream/microsoft/callback`                  |

Every call goes through the egress client QAuth hands the plugin, and only to
those two origins: the issuer and every endpoint the discovery document names
must be on one of them, so the client secret reaches no other host. Graph is
listed because the platform's discovery document puts its userinfo endpoint
there; the plugin does not read userinfo, since the ID token carries what it
maps. The plugin holds no key.

### The tenant

- **A tenant id** (a GUID, in lower case): only that tenant's accounts sign
  in. The issuer is `https://login.microsoftonline.com/<tenant id>/v2.0`, and
  an ID token any other tenant issued is refused.
- **`organizations`**: work or school accounts of any tenant. **`common`**:
  those and personal Microsoft accounts. Their discovery document names the
  issuer template `https://login.microsoftonline.com/{tenantid}/v2.0`, and an
  ID token is accepted only when its `iss` is the template with the token's
  own `tid` in place: a token whose issuer names one tenant and whose `tid`
  another, or that names no tenant, is refused. The template binds a token to
  its own tenant; it does not limit sign-in to some tenants. For one tenant,
  set its id.

Each account's credential keeps the issuer of the tenant it was created
under, so a later sign-in with the same subject from another tenant is
refused too. The account is keyed by the ID token's `sub` under that issuer,
never by an email address: a changed address or name signs in the same
account.

A domain name (`contoso.onmicrosoft.com`) is not taken as the tenant, since
the v2.0 issuer names the tenant id, which the server compares. Nor is
`consumers`, whose discovery document names another issuer than its own
path. Changing the tenant changes the issuer the client secret is bound to,
so the admin API asks for the secret again.

### Attributes

When the account is created, QAuth stores:

| Attribute            | From the claim       | Verified                                   |
| -------------------- | -------------------- | ------------------------------------------ |
| `email`              | `email`              | only when `xms_edov` is the boolean `true` |
| `name`               | `name`               | never                                      |
| `given_name`         | `given_name`         | never                                      |
| `family_name`        | `family_name`        | never                                      |
| `preferred_username` | `preferred_username` | never                                      |
| `tid`                | `tid`                | never                                      |

The `email` claim is a property of the account that its tenant's admins may
set to any address, so it is unverified by default. `xms_edov` (email domain
owner verified) is an optional claim: add it to the app registration's token
configuration for verified addresses. `email_verified` is not read. A
verified attribute ranks with an `oidc_*` provider's in QAuth's claim
resolution, since the server's own client checked the ID token.

The sign-in page shows the provider's name, `Microsoft`, and no logo: the
provider changes its brand assets, and a copy here would go stale.

## Install it (operators)

You need QAuth `0.2.3` or later, and an image you build on top of QAuth's
released one.

### 1. Register the app in Microsoft Entra ID

In the Microsoft Entra admin center, under **App registrations**, register an
application:

- **Supported account types**: this organizational directory only, for a
  fixed tenant; any organizational directory, for `organizations`; any
  organizational directory and personal Microsoft accounts, for `common`.
- **Redirect URI**: platform **Web**,
  `https://<realm host>/upstream/microsoft/callback`, one per realm host.
  `microsoftRedirectUri(realmOrigin)` of this package builds it.
- **Certificates & secrets**: add a client secret and keep its value.
- **Token configuration**: add the optional ID token claims `email` and, for
  verified addresses, `xms_edov`; `given_name` and `family_name` if you want
  them.

Keep the **Application (client) ID** and, for a fixed tenant, the
**Directory (tenant) ID** from the registration's overview.

### 2. Add the package to the server image

The image is a self-contained tree under `/app`. Install the plugin into a
separate stage, nested, so it brings its own copy of the plugin SDK, and copy
it in. `--omit=peer` makes it use the server's own `zod`; `--ignore-scripts`
runs no install script. Pin the server image by digest and the plugin by
version, and install from a lockfile you have read, so every build gets the
same dependency tree. Write the lockfile once, in a `plugins/` directory of
your build context, without installing anything:

```bash
mkdir plugins && cd plugins
npm init --yes > /dev/null
npm install --package-lock-only --save-exact --omit=dev --omit=peer \
  --install-strategy=nested --ignore-scripts @qauth-labs/plugin-microsoft@0.1.0
```

Read `package-lock.json` and commit both files. Then:

```dockerfile
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:0.2.3@sha256:<digest>

# The build stage writes the files the server will run: pin it by digest too.
FROM node:26-alpine@sha256:<digest> AS plugin
WORKDIR /plugin
COPY plugins/package.json plugins/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --install-strategy=nested --ignore-scripts

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-microsoft \
  /app/node_modules/@qauth-labs/plugin-microsoft
```

Rebuild it at every QAuth upgrade, with the lockfile moved to the plugin
version made for that release. To know the package was built by this
repository's release workflow, read the version's provenance on npmjs.com, or
the attestation at
`npm view @qauth-labs/plugin-microsoft@<version> dist.attestations.url`, and
check that it names `qauth-labs/plugin-microsoft` and
`.github/workflows/release.yml`. QAuth's own docs describe the recipe under
"Operate → Images → Add a plugin to the image".

### 3. Turn it on

```sh
AUTH_METHOD_PLUGINS=@qauth-labs/plugin-microsoft
PLUGIN_API_ENABLED=true
```

The boot logs `AuthMethod plugin @qauth-labs/plugin-microsoft loaded: microsoft (microsoft)`,
with `kind: "upstream-oidc-preset"`. With `PLUGIN_API_ENABLED` off, the server
does not load it and logs why:
`The AuthMethod plugin @qauth-labs/plugin-microsoft is not loaded: it is not a
first-party plugin, and the experimental plugin API is off. …`

The platform's hosts are public, so the deployment's egress allowlist is not
involved: a preset's calls never use it.

### 4. Configure it for a realm

Through QAuth's admin API, per realm (`{realm}` is the realm's id, `microsoft`
the plugin's name):

1. Seal the client secret:
   `POST /admin/v1-rc.0/realms/{realm}/secrets/seal` with
   `{"operation": "plugins.update", "member": "/secrets/clientSecret", "params": {"plugin": "microsoft"}, "value": "<client secret>"}`.
   The answer's `sealed` value is what the configure carries; the secret
   itself is sent nowhere else.
2. Set the configuration:
   `POST /admin/v1-rc.0/realms/{realm}/plugins/microsoft/config` with
   `{"version": <current version>, "config": {"tenant": "<tenant>", "clientId": "<client id>"}, "secrets": {"clientSecret": {"sealed": "<sealed>"}}}`.
3. Enable it: `POST /admin/v1-rc.0/realms/{realm}/plugins/microsoft/enable`
   with `{"version": <current version>}`.

Setting the configuration and enabling the plugin are security operations:
each needs an approval (`QAuth-Approval` header), as QAuth's admin API
documentation describes.

| Setting        | Required | What it is                                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------------------- |
| `tenant`       | yes      | A tenant id in lower case, `organizations` or `common` ([The tenant](#the-tenant)).         |
| `clientId`     | yes      | The application (client) id, 1 to 255 characters.                                           |
| `clientSecret` | yes      | A client secret, 1 to 1024 characters. Write-only: sealed by the server, never shown again. |

A configure that changes the tenant and keeps the stored secret is refused:
seal the secret again and send it with the new tenant.

Once enabled, the realm's sign-in offers Microsoft, and an application can
send the browser straight to it with `qauth_upstream=microsoft` on
`/oauth/authorize`. A first sign-in creates an account when the realm allows
sign-up.

## Develop

The repository uses QAuth's own toolchain: Node 26, pnpm (the version in
`package.json`'s `packageManager`), TypeScript, Oxlint, Oxfmt and Vitest.
pnpm resolves a dependency version only once it has been on the registry for
7 days (`pnpm-workspace.yaml`), as QAuth does.

```sh
pnpm install
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test
```

`pnpm test` runs the plugin SDK's preset kit (`checkUpstreamOidcPreset`) on a
fixed tenant and both multi-tenant endpoints, and the unit tests of the config
schema, the provider config each tenant makes and the attribute rules.

The end-to-end suite needs docker, openssl, Node and pnpm:

```sh
pnpm run e2e
```

It packs the plugin, builds QAuth's released server image with the plugin
added as above, starts it with PostgreSQL, Redis and a mock of the identity
platform that answers as `login.microsoftonline.com` and `graph.microsoft.com`,
configures the plugin through the admin API and signs in through the server's
pages. It checks that:

- a full sign-in creates an account with the right attributes, keyed by the
  subject under its tenant's issuer, and the email is unverified by default;
- the email is verified only when `xms_edov` is the boolean `true`;
- a token from another tenant than the configured one is refused;
- through `organizations` and `common`, a token whose issuer is the template
  with its own `tid` is accepted, and one whose issuer names another tenant,
  the endpoint, the template or another host, or that has no `tid`, is
  refused, as is the same subject from another tenant;
- a change of tenant asks for the client secret again, which is write-only;
- the access token, the ID token and the client secret are not in the
  database, the logs or the events;
- with `PLUGIN_API_ENABLED` off, the boot skips the plugin and says why.

CI runs both on every pull request. Releases are described in
[RELEASING.md](RELEASING.md).

## Not yet

- Validated against a mock of the identity platform only, not against
  Microsoft itself, which would need a real tenant.

## License

[Apache-2.0](LICENSE)
