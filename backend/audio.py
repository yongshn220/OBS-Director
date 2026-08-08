from __future__ import annotations

import logging
import math
import os
import threading
import time
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

try:
    import sounddevice as sd
    _SD_AVAILABLE = True
except (ImportError, OSError):
    sd = None
    _SD_AVAILABLE = False


class AudioMonitor:
    """Reads multi-channel audio and exposes per-channel RMS levels.

    Reliability model (status.mode):
      - "live"  : real device streaming; per-channel RMS updated by the callback.
      - "demo"  : INTENTIONAL synthetic generator (audio.demo_mode = true, or
                  sounddevice unavailable) so the UI/engine are testable without
                  an X32. Never entered as a silent fallback for a lost device.
      - "error" : the real device was expected but is unavailable OR a live
                  stream went dead (its callback stopped firing). Levels are
                  forced to ZERO — never fake audio — so the director can't act
                  on a phantom signal, and the UI raises a loud alarm. A
                  watchdog keeps trying to reopen and auto-returns to "live".
      - "idle"  : stopped.

    A background watchdog distinguishes a genuinely quiet input (callback still
    firing, levels ~0) from a DEAD device (callback stopped) by tracking the
    time of the last callback — so "quiet" and "signal lost" are never confused.
    """

    # Watchdog tuning.
    WATCHDOG_INTERVAL_S = 1.0      # how often the watchdog checks
    CALLBACK_TIMEOUT_S = 2.5       # live stream is "dead" if no callback for this long
    RECOVER_MIN_INTERVAL_S = 5.0   # min gap between reopen attempts (avoid thrashing)
    HARD_WEDGE_LIMIT = 5           # consecutive present-but-unopenable reopens → self-restart

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
        self._lock = threading.Lock()             # guards self.levels
        self._stream_lock = threading.RLock()     # serializes start/stop/recover

        # Watchdog state.
        self._last_callback_ts: float = time.monotonic()
        self._last_recover_ts: float = 0.0
        self._hard_wedge_count: int = 0
        self._watchdog_thread: threading.Thread | None = None
        self._stop_watchdog = threading.Event()

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
        """(Re)open the audio input. On failure, enters "error" (not fake demo)
        unless demo is intentional. Serialized with stop()/recover()."""
        with self._stream_lock:
            cfg = self.config_store.snapshot()["audio"]

            # Intentional synthetic demo (dev/testing) — the only path to fake data.
            if cfg.get("demo_mode") or not _SD_AVAILABLE:
                self._start_demo("sounddevice unavailable" if not _SD_AVAILABLE else None)
                return

            device_idx = self._resolve_device(cfg)
            if device_idx is None:
                self._enter_no_signal("X32 입력 장치를 찾을 수 없음")
                return

            try:
                self._close_stream()  # ensure no leftover stream
                self._stream = sd.InputStream(
                    device=device_idx,
                    channels=self.channels,
                    samplerate=cfg["samplerate"],
                    blocksize=cfg["blocksize"],
                    callback=self._audio_callback,
                )
                self._stream.start()
                # Prime the freshness clock so the watchdog waits for real
                # callbacks before judging the stream dead.
                self._last_callback_ts = time.monotonic()
                d = sd.query_devices(device_idx)
                self.status.update({
                    "mode": "live",
                    "device": d["name"],
                    "samplerate": cfg["samplerate"],
                    "error": None,
                })
            except Exception as e:
                self._enter_no_signal(f"스트림 열기 실패: {e}")

    def stop(self) -> None:
        with self._stream_lock:
            self._close_stream()
            self._stop_demo.set()
            if self._demo_thread is not None:
                self._demo_thread.join(timeout=1.0)
                self._demo_thread = None
            self.status["mode"] = "idle"

    def get_levels(self) -> list[float]:
        with self._lock:
            return list(self.levels)

    # ── Watchdog lifecycle (started/stopped by the server lifespan) ────

    def start_watchdog(self) -> None:
        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            return
        self._stop_watchdog.clear()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop, daemon=True, name="audio-watchdog"
        )
        self._watchdog_thread.start()

    def stop_watchdog(self) -> None:
        self._stop_watchdog.set()
        if self._watchdog_thread is not None:
            self._watchdog_thread.join(timeout=2.0)
            self._watchdog_thread = None

    # ── Internal: stream lifecycle ─────────────────────────────────────

    def _close_stream(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    def _enter_no_signal(self, reason: str) -> None:
        """Real device expected but unavailable / dead → alarm with ZERO levels
        (never synthetic). The watchdog will keep trying to reopen."""
        self._close_stream()
        self._stop_demo.set()
        if self._demo_thread is not None:
            self._demo_thread.join(timeout=1.0)
            self._demo_thread = None
        with self._lock:
            self.levels = [0.0] * self.channels
        self.status.update({"mode": "error", "device": None, "error": reason})
        logger.warning("audio: no signal — %s", reason)

    # Common substrings for X32-class USB audio cards. macOS reports the X32
    # USB card as "X-LIVE" or "X-USB" depending on the expansion-card variant.
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

        # 2) Score every input device that has enough channels (lower = better).
        configured_name = (cfg.get("device_name") or "").lower().strip()
        candidates: list[tuple[int, int]] = []
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] < self.channels:
                continue
            dname = d["name"].lower()
            if configured_name and configured_name in dname:
                score = 0
            elif any(k in dname for k in self._X32_KEYWORDS):
                score = 1
            else:
                score = 2
            candidates.append((score, i))

        if not candidates:
            return None
        candidates.sort()
        return candidates[0][1]

    def _audio_callback(self, indata, frames, time_info, status):
        # Freshness clock: proves the device is still delivering buffers. This is
        # what lets the watchdog tell "quiet" (callback firing, levels ~0) from
        # "dead" (callback stopped). Cheap single-float write — no lock needed.
        self._last_callback_ts = time.monotonic()
        with self._lock:
            for ch in range(self.channels):
                if ch < indata.shape[1]:
                    rms = float(np.sqrt(np.mean(indata[:, ch] ** 2)))
                    prev = self.levels[ch]
                    # Fast attack, slow release for stable VU display
                    self.levels[ch] = rms if rms > prev else prev * 0.85 + rms * 0.15

    # ── Internal: watchdog ─────────────────────────────────────────────

    def _watchdog_loop(self) -> None:
        # wait() returns True when the stop event is set → clean exit.
        while not self._stop_watchdog.wait(self.WATCHDOG_INTERVAL_S):
            try:
                self._watchdog_tick()
            except Exception:
                logger.exception("audio watchdog tick failed")

    def _watchdog_tick(self) -> None:
        cfg = self.config_store.snapshot()["audio"]
        if cfg.get("demo_mode"):
            return  # intentional demo — nothing to supervise
        now = time.monotonic()
        mode = self.status["mode"]

        if mode == "live":
            age = now - self._last_callback_ts
            if age > self.CALLBACK_TIMEOUT_S and (now - self._last_recover_ts) > self.RECOVER_MIN_INTERVAL_S:
                logger.warning("audio watchdog: no callback for %.1fs — device wedged, reopening", age)
                self._recover(f"오디오 콜백 {age:.1f}s 중단 — 장치 재연결 중")
        elif mode == "error":
            if (now - self._last_recover_ts) > self.RECOVER_MIN_INTERVAL_S:
                self._recover("장치 재연결 시도 중")
        # "idle" / "demo": leave alone.

    def _recover(self, reason: str) -> None:
        """Degrade to a zeroed alarm state, then attempt a clean in-process
        reopen. If the device is present but repeatedly won't open (a hard
        PortAudio/CoreAudio wedge — exactly today's -9986), exit so the
        LaunchAgent restarts the whole process with a fresh audio stack."""
        with self._stream_lock:
            self._last_recover_ts = time.monotonic()
            # Alarm + zero immediately so nothing acts on stale/frozen data.
            self.status.update({"mode": "error", "error": reason})
            with self._lock:
                self.levels = [0.0] * self.channels
            self._close_stream()

            present = False
            try:
                present = self._resolve_device(self.config_store.snapshot()["audio"]) is not None
            except Exception:
                present = False

            self.start()  # → "live" on success, else back to "error"

            if self.status["mode"] == "live":
                self._hard_wedge_count = 0
                logger.warning("audio watchdog: recovered")
                return

            if present:
                self._hard_wedge_count += 1
                logger.error("audio watchdog: device present but reopen failed (%d/%d): %s",
                             self._hard_wedge_count, self.HARD_WEDGE_LIMIT, self.status.get("error"))
                if self._hard_wedge_count >= self.HARD_WEDGE_LIMIT:
                    logger.critical("audio watchdog: hard audio wedge — exiting for a clean "
                                    "supervisor restart (LaunchAgent KeepAlive)")
                    os._exit(1)
            else:
                # Device simply absent (unplugged/off) — not a wedge. Keep
                # alarming and retrying cheaply; don't churn the process.
                self._hard_wedge_count = 0

    # ── Internal: intentional demo generator ───────────────────────────

    def _start_demo(self, reason: str | None) -> None:
        self._close_stream()
        self.status.update({"mode": "demo", "device": "synthetic", "error": reason})
        self._stop_demo.clear()
        self._demo_thread = threading.Thread(
            target=self._demo_loop, daemon=True, name="audio-demo"
        )
        self._demo_thread.start()

    def _demo_loop(self) -> None:
        """Synthetic level patterns so the UI is testable without an X32."""
        t0 = time.monotonic()
        while not self._stop_demo.is_set():
            t = time.monotonic() - t0
            new_levels = [0.0] * self.channels
            for ch in range(0, 3):  # singers — slow LFO
                base = 0.05 + 0.04 * math.sin(t * 0.7 + ch * 0.4)
                new_levels[ch] = max(0.0, base + 0.01 * math.sin(t * 4 + ch))
            for ch in range(3, 6):  # instruments — fast LFO
                base = 0.04 + 0.03 * math.sin(t * 2.0 + ch * 0.3)
                new_levels[ch] = max(0.0, base)
            cycle = (t % 8.0)       # pastor — periodic bursts
            new_levels[6] = 0.08 if cycle < 5.0 else 0.0005

            with self._lock:
                for ch in range(self.channels):
                    prev = self.levels[ch]
                    target = new_levels[ch]
                    self.levels[ch] = target if target > prev else prev * 0.85 + target * 0.15

            time.sleep(0.05)
