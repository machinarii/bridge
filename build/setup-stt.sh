#!/bin/bash
# Build the self-contained Parakeet v3 STT runtime under build/stt/:
#   build/stt/python     - relocatable CPython (python-build-standalone) + parakeet-mlx
#   build/stt/ffmpeg     - relocatable arm64 ffmpeg (from the ffmpeg-static npm pkg)
#   build/stt/hf-cache   - pre-downloaded Parakeet v3 MLX model (~2.5GB)
#
# This dir is later copied verbatim into Bridge.app by build-dmg.sh. Idempotent:
# re-running skips steps already complete. Proves the engine end-to-end by
# transcribing speech synthesized with macOS `say`.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STT="$ROOT/build/stt"
PYDIR="$STT/python"
HFCACHE="$STT/hf-cache"
MODEL_ID="${PARAKEET_MODEL:-mlx-community/parakeet-tdt-0.6b-v3}"
PYVER_TAG="cpython-3.12"

mkdir -p "$STT" "$HFCACHE"
log(){ echo "[setup-stt] $*"; }
fail(){ echo "[setup-stt] ERROR: $*" >&2; exit 1; }

# --- 0. confirm the v3 MLX model repo exists (don't silently downgrade) ------
log "Checking Hugging Face for $MODEL_ID ..."
if curl -fsS "https://huggingface.co/api/models/$MODEL_ID" >/dev/null 2>&1; then
  log "  found $MODEL_ID"
else
  log "  NOT found: $MODEL_ID"
  if curl -fsS "https://huggingface.co/api/models/mlx-community/parakeet-tdt-0.6b-v2" >/dev/null 2>&1; then
    fail "v3 MLX repo missing but v2 exists. Re-run with PARAKEET_MODEL=mlx-community/parakeet-tdt-0.6b-v2, or we convert v3 from nvidia weights."
  fi
  fail "Could not reach Hugging Face model API."
fi

# --- 1. relocatable Python --------------------------------------------------
if [ ! -x "$PYDIR/bin/python3" ]; then
  log "Resolving latest python-build-standalone ($PYVER_TAG, aarch64-apple-darwin, install_only)..."
  PBS_URL="$(curl -s https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
    | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 \
    | grep "$PYVER_TAG" | grep 'aarch64-apple-darwin' | grep 'install_only' \
    | grep -v 'sha256' | grep -v 'debug' | grep -v 'pgo+lto-full' | head -1)"
  [ -n "$PBS_URL" ] || fail "could not resolve python-build-standalone URL"
  log "  $PBS_URL"
  curl -L "$PBS_URL" -o "$STT/python.tar.gz" || fail "python download failed"
  tar -xzf "$STT/python.tar.gz" -C "$STT" || fail "python extract failed"   # -> $STT/python
  rm -f "$STT/python.tar.gz"
fi
PYBIN="$PYDIR/bin/python3"
[ -x "$PYBIN" ] || fail "python interpreter missing at $PYBIN"
log "python: $("$PYBIN" --version 2>&1)"

# --- 2. parakeet-mlx --------------------------------------------------------
if ! "$PYBIN" -c 'import parakeet_mlx' 2>/dev/null; then
  log "Installing parakeet-mlx (pulls mlx, numpy, huggingface_hub, ...)"
  "$PYBIN" -m pip install --upgrade pip >/dev/null 2>&1 || fail "pip upgrade failed"
  "$PYBIN" -m pip install parakeet-mlx || fail "pip install parakeet-mlx failed"
else
  log "parakeet-mlx already installed"
fi

# --- 3. relocatable STATIC ffmpeg (arm64) ----------------------------------
# parakeet_mlx/audio.py shells out to `ffmpeg` to decode, so the bundle needs a
# self-contained binary. A Homebrew ffmpeg links ~17 /opt/homebrew dylibs and is
# NOT relocatable; require a binary whose only deps are /usr/lib + /System.
ffmpeg_ok() {
  [ -x "$STT/ffmpeg" ] || return 1
  file "$STT/ffmpeg" | grep -q 'Mach-O' || return 1   # reject text/LICENSE assets
  ! otool -L "$STT/ffmpeg" 2>/dev/null | grep -qE '/opt/homebrew|/usr/local/|@rpath|@loader_path'
}
if ! ffmpeg_ok; then
  log "Fetching static arm64 ffmpeg (relocatable)..."
  rm -f "$STT/ffmpeg"
  # eugeneware/ffmpeg-static ships a standalone, statically-linked darwin-arm64
  # binary as the asset literally named `ffmpeg-darwin-arm64` (NOT the sibling
  # *.LICENSE / *.README / ffprobe-* assets — match the binary precisely).
  FF_URL="$(curl -s https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest \
    | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 \
    | grep -E '/ffmpeg-darwin-arm64(\.gz)?$' | sort | head -1)"
  log "  asset: ${FF_URL:-<none>}"
  if [ -n "$FF_URL" ]; then
    case "$FF_URL" in
      *.gz) curl -L "$FF_URL" -o "$STT/ffmpeg.gz" && gunzip -f "$STT/ffmpeg.gz" ;;
      *)    curl -L "$FF_URL" -o "$STT/ffmpeg" ;;
    esac
    chmod +x "$STT/ffmpeg" 2>/dev/null || true
  fi
  # Sanity: must be a Mach-O executable, not an accidental text asset.
  if [ -x "$STT/ffmpeg" ] && ! file "$STT/ffmpeg" | grep -q 'Mach-O'; then
    log "  fetched asset is not a Mach-O binary; discarding"
    rm -f "$STT/ffmpeg"
  fi
fi
if ffmpeg_ok; then
  log "ffmpeg (relocatable): $("$STT/ffmpeg" -version 2>/dev/null | head -1)"
else
  log "WARN: no relocatable ffmpeg — bundle would depend on a system ffmpeg!"
fi
export PATH="$STT:$PATH"

# --- 4. pre-download the model into the bundled HF cache --------------------
# Use snapshot_download with the xet transfer DISABLED — the unauthenticated
# hf-xet path hangs with zero progress. Plain HTTPS with resume is reliable.
# Clear any stale .incomplete blobs from a previous interrupted run first.
find "$HFCACHE" -name '*.incomplete' -delete 2>/dev/null || true
log "Downloading model into $HFCACHE (xet disabled; ~2.5GB; resumable)..."
HF_HOME="$HFCACHE" HF_HUB_DISABLE_XET=1 HF_XET_DISABLE=1 \
  HF_HUB_ENABLE_HF_TRANSFER=0 "$PYBIN" - "$MODEL_ID" <<'PY' || fail "model download failed"
import sys
from huggingface_hub import snapshot_download
for attempt in range(1, 6):
    try:
        p = snapshot_download(sys.argv[1], max_workers=4)
        print("SNAPSHOT_OK", p)
        break
    except Exception as e:  # noqa: BLE001
        print(f"[dl] attempt {attempt} failed: {e}", file=sys.stderr, flush=True)
        if attempt == 5:
            raise
PY
# Verify the model loads from the now-complete local cache (offline).
HF_HOME="$HFCACHE" HF_HUB_OFFLINE=1 "$PYBIN" - "$MODEL_ID" <<'PY' || fail "model load failed"
import sys
from parakeet_mlx import from_pretrained
from_pretrained(sys.argv[1])
print("MODEL_LOADED_OK")
PY

# --- 5. end-to-end transcription test --------------------------------------
log "Synthesizing test speech with macOS 'say'..."
say "testing one two three four five" -o "$STT/test.aiff" || fail "'say' failed"
"$STT/ffmpeg" -y -i "$STT/test.aiff" -ar 16000 -ac 1 "$STT/test.wav" >/dev/null 2>&1 || fail "ffmpeg convert failed"
log "Transcribing test clip..."
HF_HOME="$HFCACHE" PATH="$STT:$PATH" HF_HUB_OFFLINE=1 "$PYBIN" - "$MODEL_ID" "$STT/test.wav" <<'PY' || fail "transcription failed"
import sys
from parakeet_mlx import from_pretrained
m = from_pretrained(sys.argv[1])
r = m.transcribe(sys.argv[2])
print("TRANSCRIPT:", repr(getattr(r, "text", r)))
PY

log "Component sizes:"
du -sh "$PYDIR" "$HFCACHE" 2>/dev/null
[ -x "$STT/ffmpeg" ] && ls -lh "$STT/ffmpeg" | awk '{print "  ffmpeg "$5}'
rm -f "$STT/test.aiff" "$STT/test.wav"
log "SETUP_STT_DONE"
