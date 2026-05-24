from __future__ import annotations

import math
import time
from typing import Any


def rms_to_db(rms: float) -> float:
    if rms < 1e-7:
        return -math.inf
    return 20.0 * math.log10(rms)


class GroupEvaluator:
    """Evaluates per-group active/inactive state using attack & release timers.

    A group is "active" if any of its member channels has been over its
    threshold continuously for >= attack_ms. It returns to "inactive" only
    after all members have been under threshold for >= release_ms.

    Channels may belong to multiple groups (via ch.groups list); a channel's
    level contributes independently to each group it is a member of.
    """

    def __init__(self, config_store):
        self.config_store = config_store
        # group_name -> {"active": bool, "since": float|None, "transition": float|None}
        self._state: dict[str, dict[str, Any]] = {}

    def evaluate(self, levels: list[float]) -> dict[str, dict[str, Any]]:
        cfg = self.config_store.snapshot()
        channels_cfg = cfg["channels"]
        groups_cfg = cfg["groups"]
        now = time.monotonic()

        # Map group -> list of (channel_idx, threshold_db). A channel may
        # belong to multiple groups; it contributes its level to each one.
        members: dict[str, list[tuple[int, float]]] = {g: [] for g in groups_cfg}
        for ch in channels_cfg:
            chan_groups = ch.get("groups") or []
            # Backward compat: tolerate stale single-group field if a caller
            # bypassed ConfigStore migration (e.g. unit tests).
            if not chan_groups and ch.get("group"):
                chan_groups = [ch["group"]]
            for g in chan_groups:
                if g in members:
                    members[g].append((ch["id"] - 1, ch.get("threshold_db", -45.0)))

        result: dict[str, dict[str, Any]] = {}

        for name, group in groups_cfg.items():
            attack_ms = float(group.get("attack_ms", 200))
            release_ms = float(group.get("release_ms", 1000))

            # Is any member currently above its threshold right now?
            any_hot = False
            peak_db = -math.inf
            for idx, thr_db in members[name]:
                if 0 <= idx < len(levels):
                    db = rms_to_db(levels[idx])
                    if db > peak_db:
                        peak_db = db
                    if db >= thr_db:
                        any_hot = True

            st = self._state.setdefault(name, {
                "active": False,
                "transition_since": None,  # when raw signal flipped opposite to current state
            })

            # Track how long the raw signal has been opposite to the latched state
            if st["active"]:
                if any_hot:
                    st["transition_since"] = None
                else:
                    if st["transition_since"] is None:
                        st["transition_since"] = now
                    elif (now - st["transition_since"]) * 1000.0 >= release_ms:
                        st["active"] = False
                        st["transition_since"] = None
            else:
                if not any_hot:
                    st["transition_since"] = None
                else:
                    if st["transition_since"] is None:
                        st["transition_since"] = now
                    elif (now - st["transition_since"]) * 1000.0 >= attack_ms:
                        st["active"] = True
                        st["transition_since"] = None

            result[name] = {
                "active": st["active"],
                "raw_hot": any_hot,
                "peak_db": None if peak_db == -math.inf else round(peak_db, 1),
                "member_count": len(members[name]),
            }

        # Drop state for groups that no longer exist in config
        for stale in list(self._state.keys()):
            if stale not in groups_cfg:
                del self._state[stale]

        return result
