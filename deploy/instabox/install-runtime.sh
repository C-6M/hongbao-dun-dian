#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_root="$app_root/runtime"
version=24.12.0
expected=bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd
if [[ "$(uname -m)" != x86_64 ]]; then echo 'This artifact requires Linux x86_64' >&2; exit 1; fi
mkdir -p "$runtime_root"
archive="$runtime_root/node-v$version-linux-x64.tar.xz"
curl --fail --show-error --location --retry 2 \
  "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz" --output "$archive"
printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status
mkdir -p "$runtime_root/node"
tar -xJf "$archive" --strip-components=1 -C "$runtime_root/node"
"$runtime_root/node/bin/node" --version
"$runtime_root/node/bin/node" --test "$app_root"/tests/*.test.js
