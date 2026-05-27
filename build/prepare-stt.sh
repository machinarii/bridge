#!/usr/bin/env bash
# Pre-install Parakeet's Python deps AND pre-download the model weights
# so the packaged Bridge.app can ship them and skip the first-launch
# pip-install / HuggingFace download entirely.
#
# Output:
#   build/site-packages-arm64/   ← --target install for arm64
#   build/hf-cache/              ← HuggingFace cache with the model
#
# Run automatically by the build:mac:arm64 npm script. Re-running is
# idempotent (skips when both outputs already exist).
#
# parakeet-mlx only ships arm64 wheels, so we only do arm64 here.
# x64 builds fall back to the runtime install path (which will most
# likely fail at parakeet-mlx — that's a separate concern).

set -euo pipefail
cd "$(dirname "$0")/.."

PY_ARM64="build/python-arm64/python/bin/python3"
SITE_DIR="build/site-packages-arm64"
HF_DIR="build/hf-cache"
REQ="app/stt/requirements.txt"

if [ ! -x "$PY_ARM64" ]; then
  echo "[prepare-stt] python-build-standalone missing — running fetch-python first"
  bash build/fetch-python.sh
fi

# 1. Install deps. --target with --platform=macosx_11_0_arm64 forces
#    pip to grab the right wheels even when running from an Intel
#    Python (rare for this repo, but safe).
if [ ! -d "$SITE_DIR" ] || [ ! -e "$SITE_DIR/parakeet_mlx" ]; then
  echo "[prepare-stt] installing Python deps into $SITE_DIR"
  rm -rf "$SITE_DIR"
  "$PY_ARM64" -m pip install \
    --target "$SITE_DIR" \
    --no-cache-dir \
    -r "$REQ"
else
  echo "[prepare-stt] deps already present in $SITE_DIR — skipping"
fi

# 2. Pre-download Parakeet model into a local HF cache so the bundle
#    ships the weights. parakeet-mlx default repo:
#    mlx-community/parakeet-tdt-0.6b-v3
MODEL="${PARAKEET_MODEL:-mlx-community/parakeet-tdt-0.6b-v3}"
if [ ! -d "$HF_DIR" ] || [ -z "$(ls -A "$HF_DIR" 2>/dev/null)" ]; then
  echo "[prepare-stt] pre-downloading model $MODEL into $HF_DIR"
  mkdir -p "$HF_DIR"
  PYTHONPATH="$SITE_DIR" HF_HOME="$HF_DIR" "$PY_ARM64" -c "
from huggingface_hub import snapshot_download
import os
snapshot_download(
  repo_id='$MODEL',
  cache_dir=os.environ['HF_HOME'] + '/hub',
)
"
else
  echo "[prepare-stt] hf cache already populated — skipping"
fi

echo "[prepare-stt] done."
echo "  $SITE_DIR  ($(du -sh "$SITE_DIR" | cut -f1))"
echo "  $HF_DIR    ($(du -sh "$HF_DIR" | cut -f1))"
