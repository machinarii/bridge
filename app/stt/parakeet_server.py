"""Local Parakeet v3 STT server for Bridge.

Loads nvidia/parakeet-tdt-0.6b-v3 via parakeet-mlx (Apple Silicon GPU)
or NeMo (CUDA fallback) and exposes a tiny HTTP API:

  POST /transcribe   multipart audio file → {"text": "..."}
  GET  /health       liveness check

Bridge's Node server proxies to this. Default port is 8123 so it
doesn't collide with the Bridge web server on 4317.

Setup (Mac, Apple Silicon):
  cd app/stt
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  python parakeet_server.py

The first run downloads ~1.5 GB of weights into ~/.cache/huggingface.
"""

from __future__ import annotations

import io
import os
import sys
import time

# Prefer MLX (Apple Silicon) backend; fall back to NeMo if MLX isn't
# available (e.g. on a Linux CUDA box).
_BACKEND = None
_MODEL = None


def _load_model():
    global _BACKEND, _MODEL
    if _MODEL is not None:
        return
    repo = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
    try:
        from parakeet_mlx import from_pretrained  # type: ignore
        print(f"[parakeet] loading {repo} via parakeet-mlx …", flush=True)
        t0 = time.time()
        _MODEL = from_pretrained(repo)
        _BACKEND = "mlx"
        print(f"[parakeet] ready (mlx) in {time.time()-t0:.1f}s", flush=True)
        return
    except Exception as e:
        print(f"[parakeet] mlx unavailable ({e}); trying NeMo …", flush=True)
    try:
        from nemo.collections.asr.models import ASRModel  # type: ignore
        nemo_repo = os.environ.get("PARAKEET_MODEL_NEMO", "nvidia/parakeet-tdt-0.6b-v3")
        print(f"[parakeet] loading {nemo_repo} via NeMo …", flush=True)
        t0 = time.time()
        _MODEL = ASRModel.from_pretrained(nemo_repo)
        _BACKEND = "nemo"
        print(f"[parakeet] ready (nemo) in {time.time()-t0:.1f}s", flush=True)
        return
    except Exception as e:
        print(f"[parakeet] NeMo also failed: {e}", flush=True)
        raise


def transcribe_bytes(buf: bytes) -> str:
    _load_model()
    import soundfile as sf  # type: ignore
    audio, sr = sf.read(io.BytesIO(buf))
    # Parakeet wants float32 mono at 16 kHz. Resample if needed.
    import numpy as np
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype("float32")
    if sr != 16000:
        try:
            import librosa  # type: ignore
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
        except ImportError:
            # MLX models tolerate other rates; NeMo doesn't but most
            # callers send 16k already so this is best-effort only.
            pass
    if _BACKEND == "mlx":
        result = _MODEL.transcribe(audio)
        # parakeet-mlx returns either an object with .text or a dict.
        return getattr(result, "text", None) or result.get("text", "")
    else:
        # NeMo's transcribe takes a list of paths. Write a temp wav.
        import tempfile, soundfile as sf
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, audio, 16000)
            res = _MODEL.transcribe([tmp.name])
        if isinstance(res, list) and res:
            return res[0] if isinstance(res[0], str) else getattr(res[0], "text", "")
        return ""


def build_app():
    from fastapi import FastAPI, UploadFile
    from fastapi.responses import JSONResponse
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True, "backend": _BACKEND}

    @app.post("/transcribe")
    async def transcribe(file: UploadFile):
        try:
            text = transcribe_bytes(await file.read())
            return {"text": text}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    return app


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PARAKEET_PORT", "8123"))
    _load_model()
    uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="warning")
