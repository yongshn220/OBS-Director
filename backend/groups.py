from __future__ import annotations

import math
import time
from typing import Any


def rms_to_db(rms: float) -> float:
    if rms < 1e-7:
        return -math.inf
    return 20.0 * math.log10(rms)


class GroupEvaluator:
    """Evaluates activity for both taxonomy levels each tick:

      - groups : coarse categories (rule matching). A channel belongs to a
        group via `channel.group`.
      - roles  : fine subject identities (dynamic-planning shot targets). A
        channel is assigned a role via `channel.role`; a role inherits the
        attack/release timing of the group it belongs to.

    A bucket (group or role) is "active" if any member channel has been over
    its threshold continuously for >= attack_ms, and returns to "inactive" only
    after all members have been under threshold for >= release_ms. Attack &
    release are latched independently per bucket so brief dropouts don't flap.

    Beyond the on/off latch, each bucket also reports how STRONGLY and how LONG
    it is present — `over_db` (loudest member's headroom above its own
    threshold) and `active_for` (seconds since the latch closed). The planner
    scores these to tell a subject that is genuinely leading from one that just
    crossed the line, which a boolean alone cannot express.
    """

    def __init__(self, config_store):
        self.config_store = config_store
        # bucket_name -> {"active": bool, "transition_since": float|None,
        #                 "active_at": float|None}
        self._group_state: dict[str, dict[str, Any]] = {}
        self._role_state: dict[str, dict[str, Any]] = {}

    def evaluate(self, levels: list[float]) -> dict[str, dict[str, dict[str, Any]]]:
        """Return {"groups": {name: state}, "roles": {name: state}} where each
        state is {active, raw_hot, peak_db, over_db, active_for, member_count}."""
        cfg = self.config_store.snapshot()
        channels_cfg = cfg["channels"]
        groups_cfg = cfg["groups"]
        roles_cfg = cfg.get("roles") or {}
        now = time.monotonic()

        def group_timing(g: str) -> tuple[float, float]:
            meta = groups_cfg.get(g) or {}
            return float(meta.get("attack_ms", 200)), float(meta.get("release_ms", 1000))

        # ── Group buckets: members = channels whose .group == name ──
        group_members: dict[str, list[tuple[int, float]]] = {g: [] for g in groups_cfg}
        group_time: dict[str, tuple[float, float]] = {g: group_timing(g) for g in groups_cfg}
        # ── Role buckets: members = channels whose .role == name; a role
        #    inherits its group's timing (default when the group is missing). ──
        role_members: dict[str, list[tuple[int, float]]] = {r: [] for r in roles_cfg}
        role_time: dict[str, tuple[float, float]] = {}
        for r, meta in roles_cfg.items():
            g = (meta or {}).get("group")
            role_time[r] = group_timing(g) if g in groups_cfg else (200.0, 1200.0)

        for ch in channels_cfg:
            idx = ch["id"] - 1
            thr = ch.get("threshold_db", -45.0)
            g = ch.get("group")
            if g in group_members:
                group_members[g].append((idx, thr))
            # Backward-compat: tolerate a stale multi-group list if a caller
            # bypassed ConfigStore migration (e.g. a hand-built unit test).
            for lg in (ch.get("groups") or []):
                if lg in group_members and (idx, thr) not in group_members[lg]:
                    group_members[lg].append((idx, thr))
            r = ch.get("role")
            if r in role_members:
                role_members[r].append((idx, thr))

        group_states = self._latch(self._group_state, group_members, group_time, levels, now)
        role_states = self._latch(self._role_state, role_members, role_time, levels, now)

        # Drop latched state for buckets that no longer exist in config.
        for stale in list(self._group_state.keys()):
            if stale not in groups_cfg:
                del self._group_state[stale]
        for stale in list(self._role_state.keys()):
            if stale not in roles_cfg:
                del self._role_state[stale]

        return {"groups": group_states, "roles": role_states}

    @staticmethod
    def _latch(state_store: dict[str, dict[str, Any]],
               members: dict[str, list[tuple[int, float]]],
               timing: dict[str, tuple[float, float]],
               levels: list[float], now: float) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for name, mems in members.items():
            attack_ms, release_ms = timing.get(name, (200.0, 1000.0))

            any_hot = False
            peak_db = -math.inf
            over_db = -math.inf   # loudest member's headroom above ITS OWN threshold
            for idx, thr_db in mems:
                if 0 <= idx < len(levels):
                    db = rms_to_db(levels[idx])
                    if db > peak_db:
                        peak_db = db
                    if db - thr_db > over_db:
                        over_db = db - thr_db
                    if db >= thr_db:
                        any_hot = True

            st = state_store.setdefault(
                name, {"active": False, "transition_since": None, "active_at": None}
            )

            # Track how long the raw signal has been opposite to the latched
            # state; flip once that persists past attack (off→on) / release
            # (on→off). Any reversal resets the timer.
            if st["active"]:
                if any_hot:
                    st["transition_since"] = None
                else:
                    if st["transition_since"] is None:
                        st["transition_since"] = now
                    elif (now - st["transition_since"]) * 1000.0 >= release_ms:
                        st["active"] = False
                        st["transition_since"] = None
                        st["active_at"] = None
            else:
                if not any_hot:
                    st["transition_since"] = None
                else:
                    if st["transition_since"] is None:
                        st["transition_since"] = now
                    elif (now - st["transition_since"]) * 1000.0 >= attack_ms:
                        st["active"] = True
                        st["transition_since"] = None
                        st["active_at"] = now

            result[name] = {
                "active": st["active"],
                "raw_hot": any_hot,
                "peak_db": None if peak_db == -math.inf else round(peak_db, 1),
                "over_db": None if over_db == -math.inf else round(over_db, 1),
                "active_for": (round(now - st["active_at"], 2)
                               if st["active"] and st["active_at"] is not None else None),
                "member_count": len(mems),
            }
        return result
