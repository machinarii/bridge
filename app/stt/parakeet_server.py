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

# Imported at module level (not inside build_app) so that, with
# `from __future__ import annotations` making annotations lazy ForwardRefs,
# pydantic can resolve `UploadFile` from module globals when building the
# request validator. A local import leaves the ForwardRef undefined → 500.
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse

# Prefer MLX (Apple Silicon) backend; fall back to NeMo if MLX isn't
# available (e.g. on a Linux CUDA box).
_BACKEND = None
_MODEL = None
_MODEL_ID = None   # HF repo id of the loaded model, surfaced on /health


def _load_model():
    global _BACKEND, _MODEL, _MODEL_ID
    if _MODEL is not None:
        return
    repo = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
    try:
        from parakeet_mlx import from_pretrained  # type: ignore
        print(f"[parakeet] loading {repo} via parakeet-mlx …", flush=True)
        t0 = time.time()
        _MODEL = from_pretrained(repo)
        _BACKEND = "mlx"
        _MODEL_ID = repo
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
        _MODEL_ID = nemo_repo
        print(f"[parakeet] ready (nemo) in {time.time()-t0:.1f}s", flush=True)
        return
    except Exception as e:
        print(f"[parakeet] NeMo also failed: {e}", flush=True)
        raise


def transcribe_bytes(buf: bytes) -> str:
    _load_model()
    # parakeet-mlx (and NeMo) take a file PATH and decode it with ffmpeg, which
    # handles whatever container the browser records (webm/opus, ogg, wav…).
    # Write the raw upload to a temp file and hand it to the model — don't
    # pre-decode with soundfile, which can't read a webm container.
    import tempfile, os as _os
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(buf)
        tmp_path = tmp.name
    try:
        if _BACKEND == "mlx":
            result = _MODEL.transcribe(tmp_path)   # → AlignedResult
            return (getattr(result, "text", "") or "").strip()
        else:
            res = _MODEL.transcribe([tmp_path])    # NeMo takes a list of paths
            if isinstance(res, list) and res:
                return res[0] if isinstance(res[0], str) else getattr(res[0], "text", "")
            return ""
    finally:
        try:
            _os.unlink(tmp_path)
        except OSError:
            pass


def build_app():
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True, "backend": _BACKEND, "model": _MODEL_ID}

    @app.post("/transcribe")
    # Explicit File(...) — newer FastAPI/Starlette don't auto-classify a bare
    # `file: UploadFile` as a multipart upload, returning 422 (field in query).
    async def transcribe(file: UploadFile = File(...)):
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
