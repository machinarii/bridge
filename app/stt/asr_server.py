#!/usr/bin/env python3
"""Persistent Parakeet v3 ASR sidecar for Bridge.

All MLX work (model load AND inference) happens on ONE dedicated worker thread.
MLX's GPU stream is thread-local, so calling transcribe() from an HTTP handler
thread that didn't load the model raises "There is no Stream(gpu, 0)". The HTTP
handlers therefore just enqueue jobs and block on the worker's reply.

The model loads once at startup; the orchestrator never pays load cost per clip.

Endpoints:
  GET  /health -> {"ok": true, "ready": <bool>, "model": <id>}
  POST /asr    -> body is a 16 kHz mono 16-bit WAV; returns {"text": "..."}

Env:
  STT_PORT          listen port (default 4318)
  PARAKEET_MODEL    HF repo id (default mlx-community/parakeet-tdt-0.6b-v3)
  HF_HOME           Hugging Face cache (points at the bundled model)
  HF_HUB_OFFLINE    set to 1 by the launcher so it never hits the network
"""
import json
import os
import queue
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STT_PORT", "4318"))
MODEL_ID = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")

_ready = threading.Event()
_jobs: "queue.Queue" = queue.Queue()   # (wav_bytes, reply_queue)


def _worker():
    """Owns the MLX model: loads it, then serves transcription jobs forever."""
    from parakeet_mlx import from_pretrained
    print(f"[asr] loading {MODEL_ID} ...", flush=True)
    model = from_pretrained(MODEL_ID)
    _ready.set()
    print("[asr] model ready", flush=True)

    while True:
        wav_bytes, reply = _jobs.get()
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
                f.write(wav_bytes)
                f.flush()
                result = model.transcribe(f.name)
            text = getattr(result, "text", None)
            reply.put(("ok", (text if text is not None else str(result)).strip()))
        except Exception as e:  # noqa: BLE001 - forwarded to the client
            reply.put(("err", str(e)))


def _transcribe(wav_bytes: bytes) -> str:
    reply: "queue.Queue" = queue.Queue(maxsize=1)
    _jobs.put((wav_bytes, reply))
    status, payload = reply.get()
    if status == "err":
        raise RuntimeError(payload)
    return payload


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quieter logs
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "ready": _ready.is_set(), "model": MODEL_ID})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/asr":
            return self._json(404, {"error": "not found"})
        if not _ready.is_set():
            return self._json(503, {"error": "model not ready"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self._json(400, {"error": "empty body"})
        data = self.rfile.read(length)
        try:
            self._json(200, {"text": _transcribe(data)})
        except Exception as e:  # noqa: BLE001
            print(f"[asr] error: {e}", file=sys.stderr, flush=True)
            self._json(500, {"error": str(e)})


def main():
    threading.Thread(target=_worker, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[asr] listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
