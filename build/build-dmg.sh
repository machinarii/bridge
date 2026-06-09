#!/bin/bash
# Build a self-contained, unsigned macOS .app + .dmg for Bridge.
#
# Strategy (see app/README.md for the app itself):
#   - Bridge is a Node (Express) server that serves a Chrome-only web renderer
#     (Web Speech API + Gamepad API). We do NOT use Electron: webkitSpeechRecognition
#     only works in Google-signed Chrome, so the bundle drives the user's real Chrome.
#   - The .app bundles a Node binary and the app code, launches the server, waits for
#     /health, then opens Chrome in --app mode against it.
#   - User data (notes, scratchpad state, config, Chrome profile) lives in
#     ~/Library/Application Support/Bridge so the bundle itself stays read-only.
#
# Decisions baked in: unsigned (ad-hoc) · runtime API key (not embedded) ·
# this Mac's arch · Node bundled · Chrome app mode.
set -euo pipefail

# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/app"
BUILD="$ROOT/build"
STAGE="$BUILD/stage"
DIST="$ROOT/dist"

APP_NAME="Bridge"
BUNDLE_ID="com.aurora.bridge"
VERSION="0.1.0"
ARCH="$(uname -m)"
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
NODE_VER="$(node -v)"

BUNDLE="$BUILD/$APP_NAME.app"
CONTENTS="$BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

echo "==> Bridge DMG build"
echo "    arch=$ARCH  node=$NODE_VER ($NODE_BIN)"
echo "    bundle=$BUNDLE"

# --- clean -----------------------------------------------------------------
rm -rf "$BUNDLE" "$STAGE"
mkdir -p "$MACOS" "$RES" "$DIST"

# --- copy app code (no secrets, no user data) ------------------------------
echo "==> Copying app code"
mkdir -p "$RES/app"
rsync -a \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude 'server/.env' \
  --exclude 'notes/*.md' \
  --exclude 'state/*.json' \
  "$APP_SRC"/ "$RES/app"/
# Ensure express is present in the copied tree.
if [ ! -d "$RES/app/server/node_modules/express" ]; then
  echo "ERROR: express not found in copied node_modules. Run 'npm install' in app/server first." >&2
  exit 1
fi

# --- bundle node -----------------------------------------------------------
echo "==> Bundling node ($NODE_VER)"
cp "$NODE_BIN" "$RES/node"
chmod +x "$RES/node"

# --- bundle Parakeet v3 STT runtime (relocatable python + mlx + ffmpeg + model)
echo "==> Bundling STT runtime (Parakeet v3)"
if [ ! -x "$ROOT/build/stt/python/bin/python3" ] || [ ! -d "$ROOT/build/stt/hf-cache" ]; then
  echo "    STT runtime not built; running setup-stt.sh (downloads ~3GB, slow)..."
  bash "$BUILD/setup-stt.sh" || { echo "ERROR: setup-stt.sh failed" >&2; exit 1; }
fi
mkdir -p "$RES/stt"
rsync -a "$ROOT/build/stt/python"   "$RES/stt/"   # -> Resources/stt/python (keeps symlinks)
rsync -a "$ROOT/build/stt/hf-cache" "$RES/stt/"   # -> Resources/stt/hf-cache (HF symlinks)
if [ -x "$ROOT/build/stt/ffmpeg" ]; then
  cp "$ROOT/build/stt/ffmpeg" "$RES/stt/ffmpeg"; chmod +x "$RES/stt/ffmpeg"
fi

# --- Info.plist ------------------------------------------------------------
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Background agent feel: keep it out of the Dock? No — show it so the user
       has a quit affordance. LSUIElement left false intentionally. -->
</dict>
</plist>
PLIST

# --- launcher (Contents/MacOS/Bridge) --------------------------------------
echo "==> Writing launcher"
cat > "$MACOS/$APP_NAME" <<'LAUNCHER'
#!/bin/bash
# Bridge launcher: start the bundled Node server, then open Chrome in app mode.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"            # .../Contents/MacOS
RES="$(cd "$HERE/../Resources" && pwd)"
APP_DIR="$RES/app"
NODE_BIN="$RES/node"

APP_HOME="$HOME/Library/Application Support/Bridge"
mkdir -p "$APP_HOME/notes" "$APP_HOME/state" "$APP_HOME/chrome-profile"

LOG="$APP_HOME/bridge.log"
exec >>"$LOG" 2>&1
echo "=== Bridge launch $(date '+%Y-%m-%d %H:%M:%S') ==="

# First-run config seed (runtime API key — never embedded in the bundle).
CONFIG="$APP_HOME/config.env"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<EOF
# Bridge configuration.
# Add your OpenRouter key below to enable free-form AI answers.
# Without a key Bridge still runs using a local fallback classifier
# (take a note / show my notes work; general questions say "offline").
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
PORT=4317
EOF
  echo "seeded $CONFIG"
fi

# Load config into the environment for the server process.
set -a; . "$CONFIG"; set +a
PORT="${PORT:-4317}"
export NOTES_DIR="$APP_HOME/notes"
export STATE_DIR="$APP_HOME/state"
URL="http://localhost:$PORT"

# Start the bundled Parakeet v3 STT sidecar early, so the ~2.5GB model loads
# while Chrome is opening. Offline: model comes from the bundled HF cache.
STT_DIR="$RES/stt"
STT_PORT="${STT_PORT:-4318}"; export STT_PORT
STT_PID=""
if [ -x "$STT_DIR/python/bin/python3" ]; then
  export HF_HOME="$STT_DIR/hf-cache"
  export HF_HUB_OFFLINE=1
  export PATH="$STT_DIR:$PATH"    # bundled ffmpeg on PATH for parakeet-mlx
  export PARAKEET_MODEL="${PARAKEET_MODEL:-mlx-community/parakeet-tdt-0.6b-v3}"
  export PYTHONDONTWRITEBYTECODE=1  # never write __pycache__ into the read-only bundle
  "$STT_DIR/python/bin/python3" "$APP_DIR/stt/asr_server.py" &
  STT_PID=$!
  echo "started STT sidecar pid=$STT_PID on :$STT_PORT"
fi

alert() { /usr/bin/osascript -e "display alert \"$1\" message \"$2\"" >/dev/null 2>&1 || true; }

# Locate Chrome (required: STT/Gamepad APIs only work in real Chrome).
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  alert "Google Chrome required" "Bridge needs Google Chrome installed. Voice input (Web Speech API) and the Gamepad API only work in Chrome."
  exit 1
fi

# Reuse an already-running Bridge server, else start ours.
SERVER_PID=""
if /usr/bin/curl -fsS "$URL/health" >/dev/null 2>&1; then
  echo "reusing existing server on $PORT"
else
  ( cd "$APP_DIR/server" && exec "$NODE_BIN" server.js ) &
  SERVER_PID=$!
  echo "started node server pid=$SERVER_PID"
  ok=""
  for _ in $(seq 1 60); do
    if /usr/bin/curl -fsS "$URL/health" >/dev/null 2>&1; then ok=1; break; fi
    # bail early if the server died
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [ -z "$ok" ]; then
    alert "Bridge failed to start" "The local server did not come up on port $PORT. See $LOG for details."
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
fi

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$STT_PID" ] && kill "$STT_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Launch Chrome in app mode with an isolated profile, and block until it closes.
"$CHROME" \
  --app="$URL" \
  --user-data-dir="$APP_HOME/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1280,800
echo "chrome exited; shutting down"
LAUNCHER
chmod +x "$MACOS/$APP_NAME"

# --- icon (best effort; skipped if python3 unavailable) --------------------
echo "==> Generating icon"
if command -v python3 >/dev/null 2>&1; then
  python3 "$BUILD/make-icon.py" "$BUILD/icon_1024.png" || true
  if [ -f "$BUILD/icon_1024.png" ] && command -v iconutil >/dev/null 2>&1; then
    ICONSET="$BUILD/AppIcon.iconset"
    rm -rf "$ICONSET"; mkdir -p "$ICONSET"
    for sz in 16 32 64 128 256 512; do
      sips -z $sz $sz       "$BUILD/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}.png"       >/dev/null
      sips -z $((sz*2)) $((sz*2)) "$BUILD/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" && echo "    icon ok"
    rm -rf "$ICONSET"
  fi
else
  echo "    python3 not found; using default icon"
fi

# --- ad-hoc code sign (arm64 requires a signature to run; many nested dylibs)
echo "==> Ad-hoc signing (deep; slow with the bundled python/mlx env)"
codesign --force -s - "$RES/node" 2>/dev/null || true
[ -x "$RES/stt/ffmpeg" ] && codesign --force -s - "$RES/stt/ffmpeg" 2>/dev/null || true
# Sign nested Mach-O in the python env (dylibs/.so), then the interpreter.
find "$RES/stt" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 2>/dev/null \
  | xargs -0 -I{} codesign --force -s - {} 2>/dev/null || true
codesign --force -s - "$RES/stt/python/bin/python3" 2>/dev/null || true
codesign --force --deep -s - "$BUNDLE"
codesign --verify "$BUNDLE" && echo "    signature verified"

# --- assemble DMG ----------------------------------------------------------
echo "==> Building DMG"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$BUNDLE" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/$APP_NAME-$VERSION-$ARCH.dmg"
rm -f "$DMG"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null
rm -rf "$STAGE"

echo ""
echo "==> Done"
echo "    App: $BUNDLE"
echo "    DMG: $DMG"
ls -lh "$DMG"
