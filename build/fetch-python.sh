#!/usr/bin/env bash
# Download python-build-standalone for both macOS architectures and lay
# them out the way electron-builder's ${arch} substitution expects:
#
#   build/python-arm64/python/  (bin/python3, lib/, ...)
#   build/python-x64/python/
#
# Re-running is idempotent — already-downloaded artifacts are skipped.

set -euo pipefail
cd "$(dirname "$0")"

PY_VERSION="${PY_VERSION:-3.12.6}"
PY_TAG="${PY_TAG:-20240909}"

fetch() {
  local arch_pbs="$1"  # python-build-standalone name (aarch64 / x86_64)
  local arch_eb="$2"   # electron-builder name (arm64 / x64)
  local out="python-$arch_eb"
  if [ -x "$out/python/bin/python3" ]; then
    echo "[fetch-python] $arch_eb already present in $out/"
    return 0
  fi
  local tarball="cpython-${PY_VERSION}+${PY_TAG}-${arch_pbs}-apple-darwin-install_only.tar.gz"
  local url="https://github.com/indygreg/python-build-standalone/releases/download/${PY_TAG}/${tarball}"
  echo "[fetch-python] downloading $arch_eb from $url"
  mkdir -p "$out"
  curl -fL "$url" | tar -xz -C "$out"
  echo "[fetch-python] $arch_eb ready in $out/python"
}

fetch aarch64 arm64
fetch x86_64  x64

echo "[fetch-python] done."
