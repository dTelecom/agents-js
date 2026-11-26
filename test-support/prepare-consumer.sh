#!/usr/bin/env bash
set -euo pipefail

# Pass an empty directory outside the checkout. The second argument requests browser test dependencies.
consumer=${1:?Usage: prepare-consumer.sh EMPTY_DIRECTORY [live]}
root=$(cd "$(dirname "$0")/.." && pwd)
consumer=$(cd "$consumer" && pwd)
if [[ "$consumer/" == "$root/"* || -n "$(ls -A "$consumer")" ]]; then
  echo "Choose an empty consumer directory outside the checkout." >&2
  exit 1
fi
cd "$root"
tarball=$(npm pack --silent --pack-destination "$consumer")
cp test-support/check-package.mjs "$consumer/"
cd "$consumer"
printf '%s\n' '{"private":true,"type":"module"}' > package.json
packages=("$consumer/$tarball" "${SERVER_SDK_JS_PACKAGE:-@dtelecom/server-sdk-js@4.4.0}" "${SERVER_SDK_NODE_PACKAGE:-@dtelecom/server-sdk-node@0.4.0}")
if [[ "${2:-}" == live ]]; then
  packages+=("${CLIENT_SDK_PACKAGE:-@dtelecom/livekit-client@1.12.28}" 'playwright-core@1.65.1')
  cp "$root/test-support/live-voice.mjs" ./
  cp "${MEDIA_TEST_SUPPORT:?Set MEDIA_TEST_SUPPORT to the server-sdk-node test-support directory}/browser-call.mjs" ./
fi
npm install --engine-strict --no-audit --no-fund "${packages[@]}"
node check-package.mjs
