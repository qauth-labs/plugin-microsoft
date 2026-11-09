#!/usr/bin/env bash
# The QAuth server and migration-runner images the end-to-end suite runs on,
# built from the one qauth commit e2e/qauth-commit names.
#
# TEMPORARY. No released QAuth image carries the upstream OpenID Connect
# preset loader (qauth-labs/qauth#671) yet, so the suite cannot run on a
# released image as an operator would. Until one does, this builds
# apps/auth-server/Dockerfile and apps/migration-runner/Dockerfile of that
# commit, tagged
#
#   qauth-e2e/auth-server:<commit>
#   qauth-e2e/migration-runner:<commit>
#
# and does nothing when both are present already. Once a release carries
# #671, e2e/run.sh and e2e/compose.yml go back to the released images, pinned
# by digest, and this script and e2e/qauth-commit go.
#
# Needs docker (with BuildKit, the default since Docker 23) and git.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
commit="$(tr -d '[:space:]' < "$here/qauth-commit")"
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "e2e/qauth-commit must hold one full commit SHA of qauth-labs/qauth" >&2
  exit 1
fi
server="qauth-e2e/auth-server:$commit"
migration="qauth-e2e/migration-runner:$commit"

if docker image inspect "$server" > /dev/null 2>&1 \
  && docker image inspect "$migration" > /dev/null 2>&1; then
  echo "The QAuth images of $commit are here."
  exit 0
fi

# That one commit of qauth, nothing else of its history.
source="$here/.work-qauth"
rm -rf "$source"
mkdir -p "$source"
git -C "$source" init --quiet
git -C "$source" remote add origin https://github.com/qauth-labs/qauth.git
git -C "$source" fetch --quiet --depth 1 origin "$commit"
git -C "$source" checkout --quiet FETCH_HEAD

# From qauth's root, as its own release workflow builds them. The two share
# their first stage (the workspace and its install), which BuildKit builds
# once.
docker build --file "$source/apps/auth-server/Dockerfile" --tag "$server" "$source"
docker build --file "$source/apps/migration-runner/Dockerfile" --tag "$migration" "$source"
echo "Built $server and $migration."
