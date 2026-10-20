#!/bin/sh
# Build the base workspace image, then every team image in variants/ FROM it.
#
#   ./build.sh [tag]            tag defaults to "dev"
#   BUILD_ARGS="--build-arg APT_MIRROR=mirrors.ustc.edu.cn" ./build.sh 2026-10-20
#
# Produces dsh-sandbox:<tag> and dsh-sandbox-<variant>:<tag>. Push them to your
# registry yourself and register each one in the admin console (Images).
set -eu
cd "$(dirname "$0")"
TAG="${1:-dev}"
BUILD_ARGS="${BUILD_ARGS:-}"

# shellcheck disable=SC2086 # BUILD_ARGS is a list of words by design.
docker build $BUILD_ARGS -t "dsh-sandbox:$TAG" base
for dir in variants/*/; do
  name="$(basename "$dir")"
  # shellcheck disable=SC2086
  docker build $BUILD_ARGS --build-arg "BASE_IMAGE=dsh-sandbox:$TAG" -t "dsh-sandbox-$name:$TAG" "$dir"
done
