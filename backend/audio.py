from __future__ import annotations

import math
import threading
import time
from typing import Any

import numpy as np

try:
    import sounddevice as sd
    _SD_AVAILABLE = True
except (ImportError, OSError):
    sd = None
    _SD_AVAILABLE = False


class AudioMonitor:
    """Reads multi-channel audio and exposes per-channel RMS levels.

    Falls back to a synthetic generator if sounddevice is unavailable, the
    configured device can't be found, or demo_mode is enabled — so the rest
    of the system (UI, rule engine) is testable without the X32 plugged in.
    """

    def __init__(self, config_store):
        self.config_store = config_store
        cfg = config_store.snapshot()
        self.channels: int = cfg["audio"]["channels"]
        self.levels: list[float] = [0.0] * self.channels
        self.status: dict[str, Any] = {
            "mode": "idle",          # "live" | "demo" | "error" | "idle"
            "device": None,
            "samplerate": cfg["audio"]["samplerate"],
            "error": None,
        }

        self._stream = None
        self._demo_thread: threading.Thread | None = None
        self._stop_demo = threading.Event()
        self._lock = threading.Lock()

    # ── Public ────────────────────────────────────────────────────────

    def list_devices(self) -> list[dict[str, Any]]:
        if not _SD_AVAILABLE:
            return []
        out = []
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                out.append({
                    "index": i,
                    "name": d["name"],
                    "max_input_channels": d["max_input_channels"],
                    "default_samplerate": d.get("default_samplerate"),
                })
        return out

    def start(self) -> None:
        cfg = self.config_store.snapshot()["audio"]

        if cfg.get("demo_mode") or not _SD_AVAILABLE:
            self._start_demo("sounddevice unavailable" if not _SD_AVAILABLE else None)
            return

        device_idx = self._resolve_device(cfg)
        if device_idx is None:
            self._start_demo("X32 device not found")
            return

        try:
            self._stream = sd.InputStream(
                device=device_idx,
                channels=self.channels,
                samplerate=cfg["samplerate"],
                blocksize=cfg["blocksize"],
                callback=self._audio_callback,
            )
            self._stream.start()
            d = sd.query_devices(device_idx)
            self.status.update({
                "mode": "live",
                "device": d["name"],
                "samplerate": cfg["samplerate"],
                "error": None,
            })
        except Exception as e:
            self._start_demo(f"failed to open stream: {e}")

    def stop(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self._stop_demo.set()
        if self._demo_thread is not None:
            self._demo_thread.join(timeout=1.0)
            self._demo_thread = None
        self.status["mode"] = "idle"

    def get_levels(self) -> list[float]:
        with self._lock:
            return list(self.levels)

    # ── Internal ──────────────────────────────────────────────────────

    # Common substrings for X32-class USB audio cards.
    # macOS reports the X32 USB card as "X-LIVE" or "X-USB" depending on
    # the firmware/expansion card variant — not "X32".
    _X32_KEYWORDS = ("x32", "x-live", "x-usb", "x32 usb")

    def _resolve_device(self, cfg: dict[str, Any]) -> int | None:
        # 1) Explicit index override wins.
        if cfg.get("device_index") is not None:
            try:
                d = sd.query_devices(cfg["device_index"])
                if d["max_input_channels"] >= self.channels:
                    return cfg["device_index"]
            except Exception:
                pass

        # 2) Score every input device that has enough channels.
        #    Lower score = better match.
        configured_name = (cfg.get("device_name") or "").lower().strip()
        candidates: list[tuple[int, int]] = []
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] < self.channels:
                continue
            dname = d["name"].lower()
            if configured_name and configured_name in dname:
                score = 0  # explicit configured name
            elif any(k in dname for k in self._X32_KEYWORDS):
                score = 1  # known X32-family card name
            else:
                score = 2  # generic ≥32ch input device — almost certainly an X32-class console
            candidates.append((score, i))

        if not candidates:
            return None
        candidates.sort()
        return candidates[0][1]

    def _audio_callback(self, indata, frames, time_info, status):
        with self._lock:
            for ch in range(self.channels):
                if ch < indata.shape[1]:
                    rms = float(np.sqrt(np.mean(indata[:, ch] ** 2)))
                    prev = self.levels[ch]
                    # Fast attack, slow release for stable VU display
                    self.levels[ch] = rms if rms > prev else prev * 0.85 + rms * 0.15

    def _start_demo(self, reason: str | None) -> None:
        self.status.update({
            "mode": "demo",
            "device": "synthetic",
            "error": reason,
        })
        self._stop_demo.clear()
        self._demo_thread = threading.Thread(
            target=self._demo_loop, daemon=True, name="audio-demo"
        )
        self._demo_thread.start()

    def _demo_loop(self) -> None:
        """Generates plausible level patterns so the UI is testable.

        Channel 0-2 (singers): slow swelling vocal pattern
        Channel 3-5 (instruments): faster rhythmic pattern
        Channel 6 (pastor): occasional bursts
        Rest: quiet
        """
        t0 = time.monotonic()
        while not self._stop_demo.is_set():
            t = time.monotonic() - t0
            new_levels = [0.0] * self.channels
            # Singers — slow LFO around -25dB, occasional dips
            for ch in range(0, 3):
                base = 0.05 + 0.04 * math.sin(t * 0.7 + ch * 0.4)
                new_levels[ch] = max(0.0, base + 0.01 * math.sin(t * 4 + ch))
            # Instruments — fast LFO
            for ch in range(3, 6):
                base = 0.04 + 0.03 * math.sin(t * 2.0 + ch * 0.3)
                new_levels[ch] = max(0.0, base)
            # Pastor — periodic bursts (5s on, 3s off pattern)
            cycle = (t % 8.0)
            new_levels[6] = 0.08 if cycle < 5.0 else 0.0005

            with self._lock:
                for ch in range(self.channels):
                    prev = self.levels[ch]
                    target = new_levels[ch]
                    # smoothing same as live path
                    self.levels[ch] = target if target > prev else prev * 0.85 + target * 0.15

            time.sleep(0.05)
