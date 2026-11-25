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
packages=("$consumer/$tarball" '@dtelecom/server-sdk-js@4.3.1' '@dtelecom/server-sdk-node@0.3.3')
if [[ "${2:-}" == live ]]; then
  packages+=('@dtelecom/livekit-client@1.12.27' 'playwright-core@1.65.1')
  cp "$root/test-support/live-voice.mjs" ./
  cp "${MEDIA_TEST_SUPPORT:?Set MEDIA_TEST_SUPPORT to the server-sdk-node test-support directory}/browser-call.mjs" ./
fi
npm install --engine-strict --no-audit --no-fund "${packages[@]}"
node check-package.mjs
