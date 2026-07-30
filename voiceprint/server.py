"""Voiceprint sidecar: speaker embeddings for meeting-whisperer.

Localhost-only HTTP service. The Next.js app posts an audio file path plus
utterance segments for one diarized speaker; we slice the segments out with
ffmpeg, run them through SpeechBrain's ECAPA-TDNN speaker-verification
encoder (CPU), and return one averaged 192-dim embedding.

Endpoints:
  GET  /health           -> {"ok": true, "model_loaded": bool}
  POST /embed            -> {"embedding": [f32 x 192], "segments_used": n}
       body: {"audio_path": "/abs/path.m4a",
              "segments": [{"start_ms": int, "end_ms": int}, ...]}

Runs under pm2 as `mw-voiceprint` on 127.0.0.1:3004 (3003 is sentinel's). Stdlib HTTP server on
purpose — single client, sequential requests, no need for a web framework.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch

HOST = os.environ.get("VP_HOST", "127.0.0.1")
PORT = int(os.environ.get("VP_PORT", "3004"))
MODEL_DIR = os.environ.get(
    "VP_MODEL_DIR", os.path.expanduser("~/.mw-voiceprint/model")
)
# Cap per-segment length: ECAPA needs ~1s minimum to be meaningful, and very
# long segments add latency without accuracy. 3s..20s is the sweet spot.
MIN_SEGMENT_MS = 1000
MAX_SEGMENT_MS = 20000
MAX_SEGMENTS = 8

_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from speechbrain.inference.speaker import EncoderClassifier

            _model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=MODEL_DIR,
                run_opts={"device": "cpu"},
            )
        return _model


def slice_to_wav(audio_path: str, start_ms: int, end_ms: int) -> np.ndarray:
    """Extract [start_ms, end_ms] as 16kHz mono PCM16 via ffmpeg; return float32 [-1, 1]."""
    duration_ms = min(end_ms - start_ms, MAX_SEGMENT_MS)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{start_ms / 1000:.3f}",
                "-t", f"{duration_ms / 1000:.3f}",
                "-i", audio_path,
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                tmp_path,
            ],
            check=True,
            timeout=120,
            capture_output=True,
        )
        with wave.open(tmp_path, "rb") as w:
            frames = w.readframes(w.getnframes())
        pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def embed_speaker(audio_path: str, segments: list) -> dict:
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"audio file not found: {audio_path}")

    usable = [
        s for s in segments
        if int(s["end_ms"]) - int(s["start_ms"]) >= MIN_SEGMENT_MS
    ][:MAX_SEGMENTS]
    if not usable:
        raise ValueError("no segments >= 1s provided")

    model = get_model()
    embeddings = []
    for seg in usable:
        pcm = slice_to_wav(audio_path, int(seg["start_ms"]), int(seg["end_ms"]))
        if pcm.shape[0] < 16000:  # < 1s of actual audio after decode
            continue
        signal = torch.from_numpy(pcm).unsqueeze(0)
        with torch.no_grad():
            emb = model.encode_batch(signal).squeeze().cpu().numpy()
        embeddings.append(emb / (np.linalg.norm(emb) + 1e-10))

    if not embeddings:
        raise ValueError("no usable audio decoded from segments")

    mean = np.mean(np.stack(embeddings), axis=0)
    mean = mean / (np.linalg.norm(mean) + 1e-10)
    return {"embedding": [float(x) for x in mean], "segments_used": len(embeddings)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model_loaded": _model is not None})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length))
            result = embed_speaker(req["audio_path"], req["segments"])
            self._send(200, result)
        except FileNotFoundError as e:
            self._send(404, {"error": str(e)})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — sidecar must not die on a bad request
            print(f"[embed] error: {e}", file=sys.stderr, flush=True)
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[http] {fmt % args}", file=sys.stderr, flush=True)


def main():
    print(f"[startup] loading ECAPA model into {MODEL_DIR} ...", flush=True)
    get_model()
    print(f"[startup] model ready; listening on {HOST}:{PORT}", flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
