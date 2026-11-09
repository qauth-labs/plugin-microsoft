# The QAuth server image with this plugin added the way an operator adds it
# (QAuth's docs: operate/images, "Add a plugin to the image"). The plugin is
# the tarball `pnpm pack` made of this checkout, the same file npm would
# receive; run.sh puts it at .work/plugin.tgz.
#
# QAUTH_IMAGE is the server image, which compose.yml passes: for now the one
# e2e/qauth-images.sh builds from e2e/qauth-commit, since no released image
# carries the preset loader (qauth-labs/qauth#671) yet.
ARG QAUTH_IMAGE

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS plugin
WORKDIR /plugin
COPY .work/plugin.tgz /tmp/plugin.tgz
COPY .work/plugin-sdk.tgz /tmp/plugin-sdk.tgz
# TEMPORARY, without npm: the plugin depends on the plugin SDK as a file:
# tarball (vendor/), which cannot resolve in here. So both tarballs are
# unpacked by hand, nested as npm would nest them: the plugin brings its own
# copy of the SDK, which has no dependencies, and zod, a peer of both,
# resolves to the server's own. Once the SDK release that carries #671 is on
# npm, this goes back to plugin-github's line:
#   npm install --omit=dev --omit=peer --install-strategy=nested --ignore-scripts /tmp/plugin.tgz
RUN set -eu; \
    target=node_modules/@qauth-labs/plugin-microsoft; \
    mkdir -p /tmp/plugin /tmp/plugin-sdk "$target/node_modules/@qauth-labs"; \
    tar -xzf /tmp/plugin.tgz -C /tmp/plugin; \
    tar -xzf /tmp/plugin-sdk.tgz -C /tmp/plugin-sdk; \
    cp -R /tmp/plugin/package/. "$target"; \
    mv /tmp/plugin-sdk/package "$target/node_modules/@qauth-labs/plugin-sdk"; \
    test -f "$target/dist/index.js"; \
    test -f "$target/node_modules/@qauth-labs/plugin-sdk/dist/index.js"

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-microsoft \
  /app/node_modules/@qauth-labs/plugin-microsoft
