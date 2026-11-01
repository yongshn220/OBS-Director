"""Tempo and beat-phase tracking from percussive channels.

The director cuts on the music rather than on a stopwatch, so it needs to know
where the beats are. This runs off the same audio buffers the level meters use:
an onset detector over the beat-source channels, a tempo estimate from how
consistently those onsets fall on a regular grid, and a phase reference so the
planner can ask "when is the next grid point".

Everything here is deliberately cheap — it runs inside the audio callback path,
where an expensive analysis would drop buffers. There is no FFT: a percussive
close mic gives a clean enough amplitude envelope that spectral flux buys
nothing worth the cost.

No lock is achieved on speech or on music with no percussion, which is correct
rather than a failure — the planner falls back to timed cuts when confidence is
low, and picks the beat back up when the band comes in.
"""
from __future__ import annotations

import math
import threading
from collections import deque
from typing import Any

# Plausible musical tempo. Anything outside this is an octave error or noise.
MIN_BPM = 60.0
MAX_BPM = 180.0
# Candidate step for the tempo search. 0.5 BPM is finer than anyone can hear
# and keeps the whole search at a few thousand cheap operations.
BPM_STEP = 0.5
# Tempo prior: real services sit well inside this, and the prior is what breaks
# the tie between a period and its own half/double, which score identically.
PRIOR_CENTER_BPM = 105.0
PRIOR_WIDTH = 0.55          # in log-tempo units
# The octave the reported tempo is folded into: 70–140 BPM covers hymns through
# up-tempo worship, so a real service tempo is never itself folded away.
CANON_MIN_BPM = 70.0
CANON_MAX_BPM = 140.0
CANON_MIN_PERIOD = 60.0 / CANON_MAX_BPM
CANON_MAX_PERIOD = 60.0 / CANON_MIN_BPM

# RMS below this counts as silence for envelope purposes (~-60 dBFS). Without
# a floor, log compression turns the noise between hits into huge swings.
ENERGY_FLOOR = 1e-3
ENV_SMOOTH = 0.45           # EMA on the envelope before differencing
ONSET_SIGMA = 2.5           # onset threshold = mean + this many σ of recent flux

ONSET_WINDOW_S = 10.0       # onsets older than this stop voting
FLUX_WINDOW_S = 2.0         # baseline window for the adaptive onset threshold
MIN_ONSET_GAP_S = 0.09      # debounce: no two onsets closer than this
MIN_ONSETS = 8              # below this there is nothing to estimate from
ESTIMATE_EVERY_S = 0.35     # re-estimate at most this often
LOCK_CONFIDENCE = 0.55      # concentration needed to call the beat "locked"
DROP_CONFIDENCE = 0.35      # ...and to keep it; hysteresis stops lock flapping


class BeatTracker:
    """Thread-safe: fed from the audio callback, read from the tick loop."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._env = 0.0
        self._prev_env = 0.0
        self._flux: deque[tuple[float, float]] = deque()   # (t, flux)
        self._onsets: deque[float] = deque()               # onset timestamps
        self._last_onset_t = -1e9
        self._last_estimate_t = -1e9
        self._period: float | None = None      # seconds per beat
        self._phase: float = 0.0               # grid offset, seconds
        self._confidence: float = 0.0
        self._locked: bool = False

    # ── Fed from the audio callback ───────────────────────────────

    def feed(self, energy: float, now: float) -> None:
        """One audio block's energy across the beat-source channels."""
        # Log compression so a quiet hit and a loud one look alike, with a floor
        # so the near-silence between hits does not sit on the steep part of the
        # curve — down there, ordinary noise swings the envelope as far as a
        # real hit does and every block reads as an onset.
        env_raw = math.log1p(max(0.0, energy) / ENERGY_FLOOR)
        # Short smoothing: block-to-block noise is uncorrelated and averages
        # out over ~30ms, while a drum attack stays up for longer than that.
        self._env += (env_raw - self._env) * ENV_SMOOTH
        flux = self._env - self._prev_env
        self._prev_env = self._env
        if flux < 0.0:
            flux = 0.0     # onsets are rises only; decays carry no information

        with self._lock:
            self._flux.append((now, flux))
            cutoff = now - FLUX_WINDOW_S
            while self._flux and self._flux[0][0] < cutoff:
                self._flux.popleft()

            # Adaptive threshold from the recent spread, not a fixed level: a
            # mean-multiple breaks down when the baseline flux is near zero
            # (any blip is then "many times the mean"), which is exactly the
            # case between hits. mean + k·σ stays sane at both extremes.
            n = len(self._flux)
            if n < 16:
                return
            vals = [f for _, f in self._flux]
            mean = sum(vals) / n
            var = sum((v - mean) ** 2 for v in vals) / n
            thr = mean + ONSET_SIGMA * math.sqrt(var) + 1e-4
            if flux > thr and (now - self._last_onset_t) >= MIN_ONSET_GAP_S:
                self._last_onset_t = now
                self._onsets.append(now)
                ocut = now - ONSET_WINDOW_S
                while self._onsets and self._onsets[0] < ocut:
                    self._onsets.popleft()

            if now - self._last_estimate_t >= ESTIMATE_EVERY_S:
                self._last_estimate_t = now
                self._estimate(now)

    # ── Read from the tick loop ───────────────────────────────────

    def snapshot(self, now: float) -> dict[str, Any]:
        with self._lock:
            locked = self._locked and self._period is not None
            return {
                "locked": locked,
                "bpm": round(60.0 / self._period, 1) if (locked and self._period) else None,
                "confidence": round(self._confidence, 2),
                "period": self._period if locked else None,
                "onsets": len(self._onsets),
            }

    def next_grid_after(self, t: float, beats: int) -> float | None:
        """The next point on a grid of `beats` beats, or None with no lock.

        The grid is anchored on the tracked phase, not on a detected downbeat:
        finding the true "1" needs meter detection, and it buys nothing here.
        What matters is that cuts land consistently on the same subdivision, so
        they feel placed rather than scattered across the bar.
        """
        with self._lock:
            if not self._locked or not self._period:
                return None
            span = self._period * max(1, beats)
            # The epsilon matters: callers walk the grid by feeding back the
            # point they just got, and without it (t - phase)/span lands a hair
            # under the integer it should equal, so floor()+1 hands back the
            # same point forever.
            k = math.floor((t - self._phase) / span + 1e-9) + 1
            return self._phase + k * span

    # ── Internal ──────────────────────────────────────────────────

    def _estimate(self, now: float) -> None:
        """Pick the period whose grid the recent onsets sit on most tightly.

        Scored by circular concentration: express each onset as a phase within
        a candidate period, then measure how tightly those phases cluster. That
        is phase-invariant, so the search does not have to try grid offsets, and
        the same statistic gives both the confidence and the offset itself.
        """
        onsets = [t for t in self._onsets if now - t <= ONSET_WINDOW_S]
        if len(onsets) < MIN_ONSETS:
            self._decay()
            return

        best_score = 0.0
        best_period = None
        best_phase = 0.0
        bpm = MIN_BPM
        while bpm <= MAX_BPM:
            period = 60.0 / bpm
            c = s = 0.0
            for t in onsets:
                ang = 2.0 * math.pi * ((t / period) % 1.0)
                c += math.cos(ang)
                s += math.sin(ang)
            n = len(onsets)
            r = math.hypot(c, s) / n          # 0 = scattered, 1 = dead on grid
            # A period and its half score identically — every onset on the beat
            # also sits on the off-beat grid. The prior is what decides which
            # octave we report, so it is doing real work, not cosmetics.
            prior = math.exp(-0.5 * (math.log(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH) ** 2)
            score = r * prior
            if score > best_score:
                best_score = score
                best_period = period
                best_phase = (math.atan2(s, c) / (2.0 * math.pi)) % 1.0
            bpm += BPM_STEP

        if best_period is None:
            self._decay()
            return

        self._confidence = best_score
        # Hysteresis: lock needs a clear reading, but holding it needs less, so
        # a bar of quiet or a fill does not drop the beat and re-acquire it.
        if best_score >= LOCK_CONFIDENCE:
            self._locked = True
        elif best_score < DROP_CONFIDENCE:
            self._locked = False
        if self._locked:
            period, phase01 = self._fold_octave(best_period, best_phase)
            self._period = period
            self._phase = phase01 * period

    @staticmethod
    def _fold_octave(period: float, phase01: float) -> tuple[float, float]:
        """Fold the period into a canonical tempo range.

        A grid of period P scores identically to one of P/2 — onsets on the
        beat also sit on the off-beat grid — so the search cannot tell them
        apart and routinely reports double or half. That is not a cosmetic
        problem: shots are held for a number of beats, so a doubled tempo
        halves every shot. Folding into one canonical octave makes the reported
        tempo stable no matter which multiple won the search, and the phase
        survives because doubling the period keeps every second grid line.
        """
        while period < CANON_MIN_PERIOD:
            period *= 2.0
            phase01 = (phase01 / 2.0) % 1.0
        while period >= CANON_MAX_PERIOD:
            period /= 2.0
            phase01 = (phase01 * 2.0) % 1.0
        return period, phase01

    def _decay(self) -> None:
        self._confidence *= 0.7
        if self._confidence < DROP_CONFIDENCE:
            self._locked = False
