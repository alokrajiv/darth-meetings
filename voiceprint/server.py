"""Voiceprint sidecar: speaker embeddings for meeting-whisperer.

Localhost-only HTTP service. The Next.js app posts an audio file path plus
utterance segments for one diarized speaker; we slice the segments out with
ffmpeg, run them through SpeechBrain's ECAPA-TDNN speaker-verification
encoder (CPU), and return one averaged 192-dim embedding.

It also lines two recordings of the same meeting up in time — the envelope
cross-correlation that was done by hand for the SI-BL merge
(docs/recordings-phase3b-combine-spec.md). Same deployment, same process; it
needs nothing beyond numpy, which is already here.

Endpoints:
  GET  /health           -> {"ok": true, "model_loaded": bool}
  POST /embed            -> {"embedding": [f32 x 192], "segments_used": n}
       body: {"audio_path": "/abs/path.m4a",
              "segments": [{"start_ms": int, "end_ms": int}, ...]}
  POST /align            -> {"offsetMs": int, "confidence": f, "driftPpm": f|null,
                             "method": str, "overlapMs": int|null}
       body: {"a": "/abs/a.m4a", "b": "/abs/b.m4a",
              "nominalMs": int, "windowMs": int}
       How far B starts AFTER A, in ms. Never applied automatically — the
       caller shows it and a person clicks "Use this offset".

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


# ---------------------------------------------------------------------------
# /align — line two recordings of one meeting up in time
# ---------------------------------------------------------------------------
#
# The method, unchanged from the hand-run SI-BL merge (2026-09-04): decode both
# files to mono 8 kHz, reduce each to a 100 Hz LOG-RMS envelope (one number per
# 10 ms: loud/quiet, not the waveform), z-score both, and cross-correlate them
# with an FFT. Two different microphones in one room record wildly different
# spectra but the SAME loudness pattern, which is why the envelope works where
# a sample-level correlation does not.
#
# numpy only, on purpose: the sidecar's venv already has it (it comes with
# torch), so this endpoint adds NO dependency to the VM.

ENVELOPE_HZ = 100
ENVELOPE_RATE = 8000
ENVELOPE_HOP = ENVELOPE_RATE // ENVELOPE_HZ  # 80 samples = 10 ms
# Below this much shared audio a "match" means nothing.
MIN_OVERLAP_FRAMES = 30 * ENVELOPE_HZ  # 30 s
# A peak this close to another one is the same peak, not a rival.
PEAK_GUARD_FRAMES = 2 * ENVELOPE_HZ  # 2 s
# Refuse absurd inputs rather than allocate for them.
MAX_HOURS = 12
# Drift is only measurable over a long shared stretch.
DRIFT_MIN_OVERLAP_FRAMES = 10 * 60 * ENVELOPE_HZ  # 10 min
DRIFT_SEARCH_FRAMES = 5 * ENVELOPE_HZ  # +/- 5 s around the global lag


def log_rms_envelope(audio_path: str) -> np.ndarray:
    """100 Hz log-RMS envelope of a file, streamed (a 5 h video must not be
    held in memory as PCM: the envelope of one is 7 MB, the PCM is 576 MB)."""
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"audio file not found: {audio_path}")
    proc = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", audio_path,
            "-ac", "1", "-ar", str(ENVELOPE_RATE), "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    frames = []
    carry = b""
    chunk_frames = ENVELOPE_HOP * 2 * 20000  # ~200 s per read
    max_frames = MAX_HOURS * 3600 * ENVELOPE_HZ
    try:
        while True:
            buf = proc.stdout.read(chunk_frames)
            if not buf:
                break
            buf = carry + buf
            usable = (len(buf) // (ENVELOPE_HOP * 2)) * (ENVELOPE_HOP * 2)
            carry = buf[usable:]
            if usable == 0:
                continue
            pcm = np.frombuffer(buf[:usable], dtype=np.int16).astype(np.float32) / 32768.0
            pcm = pcm.reshape(-1, ENVELOPE_HOP)
            frames.append(np.sqrt(np.mean(pcm * pcm, axis=1, dtype=np.float64)))
            if sum(f.shape[0] for f in frames) > max_frames:
                raise ValueError(f"audio longer than {MAX_HOURS} h: {audio_path}")
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        err = proc.stderr.read().decode("utf-8", "replace")[-400:]
        proc.stderr.close()
        code = proc.wait()
    if not frames:
        raise ValueError(f"no audio decoded from {audio_path}: {err.strip() or f'ffmpeg exit {code}'}")
    rms = np.concatenate(frames)
    # log, so a quiet passage still carries shape (the SI-BL phone clip was
    # ~40 dB below the Teams track and a linear envelope simply ignored it).
    return np.log10(rms + 1e-6).astype(np.float64)


def _zscore(x: np.ndarray) -> np.ndarray:
    x = x - x.mean()
    sd = x.std()
    return x / sd if sd > 1e-9 else x


def _lag_scores(ea: np.ndarray, eb: np.ndarray):
    """Mean product of the two envelopes at every integer lag.

    Returns (scores, lags) where `scores[i]` belongs to `lags[i]`, and a lag L
    means: B's frame 0 sits at A's frame L (B started L frames AFTER A).
    """
    na, nb = ea.shape[0], eb.shape[0]
    n = 1 << int(np.ceil(np.log2(na + nb)))
    fa = np.fft.rfft(ea, n)
    fb = np.fft.rfft(eb[::-1], n)
    full = np.fft.irfft(fa * fb, n)[: na + nb - 1]
    lags = np.arange(na + nb - 1) - (nb - 1)
    # How many frames actually overlap at each lag — without this, the longest
    # overlap always wins and the answer is "line them up end to end".
    counts = np.minimum(na, nb + lags) - np.maximum(0, lags)
    scores = np.full(full.shape, -np.inf)
    ok = counts >= MIN_OVERLAP_FRAMES
    scores[ok] = full[ok] / counts[ok]
    return scores, lags, counts


def _best_in_window(scores, lags, nominal_lag: int, window_lag: int):
    lo = np.searchsorted(lags, nominal_lag - window_lag, "left")
    hi = np.searchsorted(lags, nominal_lag + window_lag, "right")
    lo, hi = max(0, lo), min(scores.shape[0], hi)
    if hi <= lo:
        return None
    band = scores[lo:hi]
    if not np.isfinite(band).any():
        return None
    i = int(np.nanargmax(np.where(np.isfinite(band), band, -np.inf)))
    return lo + i, band, lo


def _confidence(band: np.ndarray, peak_index_in_band: int) -> float:
    """How far the peak stands above everything else in the search window.

    1.0 = nothing else comes close; 0 = the "peak" is the background. NOT a
    probability, and never a licence to apply the offset on its own.
    """
    peak = band[peak_index_in_band]
    if not np.isfinite(peak) or peak <= 0:
        return 0.0
    mask = np.isfinite(band).copy()
    lo = max(0, peak_index_in_band - PEAK_GUARD_FRAMES)
    hi = min(band.shape[0], peak_index_in_band + PEAK_GUARD_FRAMES + 1)
    mask[lo:hi] = False
    rest = band[mask]
    if rest.size == 0:
        return 1.0
    background = float(np.percentile(rest, 99))
    if background <= 0:
        return 1.0
    return float(max(0.0, min(1.0, 1.0 - background / peak)))


def _drift_ppm(ea, eb, lag: int):
    """Clock drift between the two devices, ppm, by re-aligning the first and
    last thirds of the shared stretch separately (~50 ppm on the SI-BL pair).

    Sign: NEGATIVE means the offset shrinks as the meeting goes on — B's clock
    runs slow, so its audio creeps earlier relative to A. Positive is the
    other way round. None = the two files share too little to measure it.
    """
    lo = max(0, lag)
    hi = min(ea.shape[0], eb.shape[0] + lag)
    overlap = hi - lo
    if overlap < DRIFT_MIN_OVERLAP_FRAMES:
        return None
    margin = DRIFT_SEARCH_FRAMES
    seg = (overlap - 2 * margin) // 3
    if seg < MIN_OVERLAP_FRAMES:
        return None
    centres, lags = [], []
    # The two windows are pulled `margin` inside the overlap so the local
    # search always has room on both sides of B (without it the first window
    # sits flush against B's frame 0 and the estimate is simply skipped).
    for start in (lo + margin, hi - margin - seg):
        a = ea[start : start + seg]
        b_start = start - lag - margin
        b_end = start - lag + seg + margin
        if b_start < 0 or b_end > eb.shape[0]:
            return None
        valid, _, _ = _lag_scores_small(_zscore(a), _zscore(eb[b_start:b_end]))
        if valid is None:
            return None
        i = int(np.argmax(valid))
        # a[0] is A frame `start` and matches b[i]; b[0] is A frame
        # `start - margin`, so B frame 0 sits at A frame `lag - (i - margin)`.
        centres.append(start + seg / 2)
        lags.append(lag - (i - margin) - _parabolic(valid, i))
    dt = centres[1] - centres[0]
    if dt <= 0:
        return None
    return float((lags[1] - lags[0]) / dt * 1e6)


def _parabolic(v: np.ndarray, i: int) -> float:
    """Sub-frame refinement of a correlation peak. One frame is 10 ms, and a
    drift of 50 ppm over ten minutes is only three frames — without this the
    quantisation IS the answer."""
    if i <= 0 or i >= v.shape[0] - 1:
        return 0.0
    y0, y1, y2 = float(v[i - 1]), float(v[i]), float(v[i + 1])
    denom = y0 - 2 * y1 + y2
    if abs(denom) < 1e-12:
        return 0.0
    return float(max(-0.5, min(0.5, 0.5 * (y0 - y2) / denom)))


def _lag_scores_small(a: np.ndarray, b: np.ndarray):
    """Correlate a short window `a` against the slightly longer `b`."""
    na, nb = a.shape[0], b.shape[0]
    if na < MIN_OVERLAP_FRAMES // 6 or nb <= na:
        return None, None, None
    n = 1 << int(np.ceil(np.log2(na + nb)))
    full = np.fft.irfft(np.fft.rfft(b, n) * np.fft.rfft(a[::-1], n), n)
    valid = full[na - 1 : nb]
    return valid, np.arange(valid.shape[0]), None


def align_recordings(a_path: str, b_path: str, nominal_ms: int, window_ms: int) -> dict:
    ea = _zscore(log_rms_envelope(a_path))
    eb = _zscore(log_rms_envelope(b_path))
    if ea.shape[0] < MIN_OVERLAP_FRAMES or eb.shape[0] < MIN_OVERLAP_FRAMES:
        raise ValueError("both recordings need at least 30 s of audio to be lined up")

    scores, lags, counts = _lag_scores(ea, eb)
    nominal_lag = int(round(nominal_ms / (1000 / ENVELOPE_HZ)))
    window_lag = max(1, int(round(window_ms / (1000 / ENVELOPE_HZ))))
    found = _best_in_window(scores, lags, nominal_lag, window_lag)
    if found is None:
        raise ValueError("the two recordings do not overlap inside that search window")
    index, band, band_lo = found
    lag = int(lags[index])
    confidence = _confidence(band, index - band_lo)
    drift = _drift_ppm(ea, eb, lag) if confidence >= 0.4 else None
    overlap = int(counts[index]) if np.isfinite(scores[index]) else 0

    return {
        "offsetMs": int(lag * (1000 // ENVELOPE_HZ)),
        "confidence": round(confidence, 4),
        "driftPpm": None if drift is None else round(drift, 2),
        "method": f"log-rms-envelope-{ENVELOPE_HZ}hz-fft-xcorr",
        "overlapMs": overlap * (1000 // ENVELOPE_HZ),
        "nominalMs": int(nominal_ms),
        "windowMs": int(window_ms),
    }


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
        if self.path not in ("/embed", "/align"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length))
            if self.path == "/align":
                result = align_recordings(
                    req["a"],
                    req["b"],
                    int(req.get("nominalMs") or 0),
                    int(req.get("windowMs") or 120000),
                )
            else:
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
