#!/bin/sh
# Pin the Dockerfile's base images to their current digests for reproducible builds.
# Needs Docker. Run again whenever you want to pick up new base-image patches, then commit.
set -eu
cd "$(dirname "$0")/.."
for image in golang:1.27-alpine gcr.io/distroless/static-debian12:nonroot; do
  docker pull -q "$image" >/dev/null
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$image" | sed 's/.*@//')
  base=${image%%@*}
  # Replace "FROM <image>" or "FROM <image>@sha256:..." with the pinned reference.
  sed -i.bak -E "s#^FROM ${base}(@sha256:[a-f0-9]+)?#FROM ${base}@${digest}#" Dockerfile
  echo "pinned ${base}@${digest}"
done
rm -f Dockerfile.bak
