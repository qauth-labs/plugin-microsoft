# Releasing

`@qauth-labs/plugin-microsoft` is released to npm from a tag of this repository,
by `.github/workflows/release.yml`, through npm's trusted publishing: the
workflow proves who it is with GitHub's OIDC token, holds no npm token, and
npm attaches provenance. The workflow only **stages** the version; it goes
live when a maintainer approves the stage on npmjs.com with 2FA. This is the
way QAuth's own SDK packages are released (`release-npm.yml` in
qauth-labs/qauth).

## Versions

The package has its own version line, not QAuth's.

- `0.x` while QAuth's plugin API is experimental (`PLUGIN_API_ENABLED`).
- Each release is preceded by release candidates, `X.Y.Z-rc.N`, which go to
  the `next` dist-tag. A release goes to `latest`. No other pre-release form
  is published.
- The README's compatibility table says which QAuth versions and which
  AuthMethod contract each version is for. Update it in the same pull request
  as the version.

## Before the first release

Two dependencies are temporary, and both go before `0.1.0-rc.0` is tagged:

- **The plugin SDK** is the tarball in `vendor/` (`vendor/README.md`), since
  the SDK release with the upstream OpenID Connect preset shape
  (qauth-labs/qauth#671) is not on npm yet. Once it is, depend on that version
  from npm, add it to `pnpm-workspace.yaml`'s cooldown exceptions while it is
  younger than seven days, delete `vendor/`, and put `e2e/Dockerfile`'s
  `npm install` line back.
- **The server images** of the end-to-end suite are built from the qauth
  commit `e2e/qauth-commit` names (`e2e/qauth-images.sh`), since no released
  image carries the preset loader yet. Once a release does, pin its
  `auth-server` and `migration-runner` images by digest in `e2e/run.sh` and
  `e2e/compose.yml`, drop the CI step that builds them, and delete
  `e2e/qauth-images.sh` and `e2e/qauth-commit`.

## Cut a release

1. In a pull request, set `version` in `package.json` (for example
   `0.1.0-rc.1`) and move the `Unreleased` entries of `CHANGELOG.md` under `## [0.1.0-rc.1]`,
   update the links at the bottom and the README's compatibility table. Merge
   it when CI is green.

2. Tag the merge commit on `main` and push the tag:

   ```sh
   git tag -s v0.1.0-rc.1 -m v0.1.0-rc.1
   git push origin v0.1.0-rc.1
   ```

3. `release.yml` runs the whole CI again (checks, contract test kit,
   end-to-end suite), checks that the tag points at a commit on `main`, that
   it names the version in `package.json` and that `CHANGELOG.md` has its
   section, builds and packs the tarball once with pnpm and stages it on npm
   (`npm stage publish`), from the `npm` environment.

4. Approve the stage on npmjs.com with 2FA. Check the version, the dist-tag
   and the provenance before approving.

5. Publish the draft GitHub release the run left, with the tarball and the
   changelog section.

## One-time setup

These steps are a maintainer's, and none of them is done yet. npm configures a
trusted publisher only for a package that exists. Before the first release, a
maintainer:

1. Publishes a placeholder by hand, from an empty directory, once:
   `@qauth-labs/plugin-microsoft@0.0.0` with only a `package.json` and a README
   that points here.
2. On npmjs.com, under the package's settings, adds the trusted publisher:
   the organisation `qauth-labs`, the repository `plugin-microsoft`, the
   workflow `release.yml`, the environment `npm`. Then sets publishing access
   to require 2FA and disallow tokens.
3. In this repository's settings, creates the `npm` environment and limits
   it to tags matching `v*`, and adds a tag ruleset that lets only
   maintainers create or move `v*` tags.

Nothing else holds a credential: the workflow's `id-token: write` permission
is granted only to the job that stages the package.
