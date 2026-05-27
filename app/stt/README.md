# Local Parakeet v3 STT for Bridge

Tiny FastAPI service that loads NVIDIA's Parakeet v3 ASR model locally
and exposes a `POST /transcribe` endpoint. Bridge's Node server
proxies to it; the renderer hits Bridge's proxy with audio captured
via `MediaRecorder`.

## One-time setup (macOS, Apple Silicon)

```bash
cd app/stt
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The first call downloads ~1.5 GB of weights into
`~/.cache/huggingface`. Subsequent runs reuse the cache.

## Run

```bash
source .venv/bin/activate
python parakeet_server.py
```

Default port: `8123`. Override with `PARAKEET_PORT=…`. Default model:
`mlx-community/parakeet-tdt-0.6b-v3`. Override with `PARAKEET_MODEL=…`.

Keep this running in a separate terminal (or set up a launchd plist
to start it at login).

## Wire to Bridge

In Settings → General, set **Local STT URL** to
`http://localhost:8123/transcribe`. If empty, Bridge falls back to
the browser's `webkitSpeechRecognition`.

## Health check

```bash
curl http://localhost:8123/health
# → {"ok": true, "backend": "mlx"}
```

## Linux / CUDA

`parakeet-mlx` is Apple Silicon only. On Linux:

1. Uncomment `nemo_toolkit[asr]>=2.0` in `requirements.txt`.
2. Reinstall: `pip install -r requirements.txt`.
3. Run as before — the server will fall back to NeMo automatically.
