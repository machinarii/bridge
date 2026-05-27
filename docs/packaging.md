# Packaging Bridge as a macOS app

Bridge is wrapped in a thin Electron host (`app/electron/main.js`).
The Electron main process boots the Node server inline, optionally
launches the local Parakeet STT service if installed, and opens a
window at `http://127.0.0.1:4317/`. The renderer is unchanged from
the web version.

## Dev workflow

```bash
# from the repo root
npm install                # pulls electron + electron-builder

# run the app
npm run dev                # spawns Electron with the server inline
```

Logs from the Node server and (optionally) the Parakeet child
process stream to the terminal. DevTools opens via the Bridge menu
or ⌥⌘I.

## Local Parakeet STT

### In the packaged `.app`

Python is **bundled** with the app via `python-build-standalone`. On
first launch, Electron pip-installs Parakeet's dependencies into the
user-data directory (`~/Library/Application Support/Bridge/stt-packages/`)
and shows a one-time "Local STT ready" notification when finished.
Subsequent launches skip the install and go straight to spawning the
service.

The user only needs to:
1. Launch the app once (waits ~1–3 min for the pip install).
2. Open Settings → General and set **Local STT URL** to
   `http://localhost:8123/transcribe`.

No Python install, no venv setup, no homebrew.

### Dev mode

When running `npm run dev` from source, Electron falls back to the
legacy venv path so contributors don't need to fetch python-build-
standalone for every iteration:

```bash
cd app/stt
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

Next `npm run dev` detects `app/stt/.venv/bin/python` and launches
the Parakeet server. Without the venv, Bridge falls back to the
browser's built-in speech recognition.

## Build a `.app` / `.dmg`

```bash
npm install
npm run build:mac:arm64       # Apple Silicon only
# or
npm run build:mac:x64         # Intel only
# or
npm run build:mac             # universal (both architectures)
```

The `build:mac*` scripts first run `build/fetch-python.sh` to
download a relocatable Python 3.12 (python-build-standalone) for
each target architecture into `build/python-arm64/` and
`build/python-x64/`. Those directories are git-ignored and ~120 MB
each. electron-builder substitutes `${arch}` at pack time so each
build only includes the matching Python.

After build, the bundle contains:

```
Bridge.app/Contents/Resources/
  python/bin/python3   ← the bundled CPython
  stt/parakeet_server.py
  stt/requirements.txt
```

First launch pip-installs Parakeet's deps into the user-data dir
(see "Local Parakeet STT" above).

`electron-builder` writes the artifacts to `dist/`:

- `dist/Bridge-<version>-arm64.dmg` — installer
- `dist/Bridge-<version>-arm64-mac.zip` — drag-to-Applications copy
- `dist/mac-arm64/Bridge.app` — the raw bundle

`.app` is self-contained except for the optional Parakeet venv —
that's still keyed off `app/stt/.venv/` inside the bundle (under
`Bridge.app/Contents/Resources/stt/.venv/`). Users who want
Parakeet inside the packaged app can `cd` into that resource path
and run the venv install once. Heavier "bundle a fully embedded
Python" packaging is a follow-up; for now, the optional service
keeps the build light.

## Code signing & notarization

The default build is **unsigned**. macOS Gatekeeper will warn on
first launch ("from an unidentified developer"). To ship to other
users:

1. Set `CSC_LINK` / `CSC_KEY_PASSWORD` env vars to your `.p12` cert.
2. Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
   for notarization (electron-builder picks these up automatically).
3. `npm run build:mac:arm64` re-runs with signing + notarization.

For local-only use, just right-click → Open the first time.

## What's in the bundle

| Path inside `Bridge.app/Contents` | What |
|---|---|
| `MacOS/Bridge` | Electron host binary |
| `Resources/app.asar` | `app/electron/`, `app/server/`, `app/renderer/` packed |
| `Resources/stt/` | `parakeet_server.py`, `requirements.txt`, README |
| `Resources/app.asar.unpacked/app/server/node_modules` | server deps |

Things deliberately NOT bundled:

- `app/state/` — per-project user data, lives in the user's
  app-support directory.
- Python venv — opt-in; users install it once if they want Parakeet.
- `.env` — secrets live outside the bundle.
