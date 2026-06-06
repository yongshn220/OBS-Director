from __future__ import annotations

import logging
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from typing import Any

logger = logging.getLogger(__name__)


def new_rule_id() -> str:
    return "rule_" + uuid.uuid4().hex[:8]


def default_rule() -> dict[str, Any]:
    return {
        "id": new_rule_id(),
        "name": "새 룰",
        "priority": 0,
        "enabled": True,
        "conditions": [],          # [] = always match (catch-all)
        "actions": [],
        "cooldown_s": 3.0,
    }


def normalize_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """Ensure the rule has all required fields with valid types.

    Supported action types:
      - http_request : low-level POST/GET to the ASS HTTP server (escape hatch)
      - transition   : activate a rotation (deck of macros) while the rule holds
    Any other action type is dropped silently.
    """
    r = {
        "id": rule.get("id") or new_rule_id(),
        "name": str(rule.get("name") or "새 룰"),
        "priority": int(rule.get("priority", 0)),
        "enabled": bool(rule.get("enabled", True)),
        "conditions": [],
        "actions": [],
        "cooldown_s": float(rule.get("cooldown_s", 3.0)),
    }
    for c in rule.get("conditions") or []:
        r["conditions"].append({
            "group": str(c.get("group", "")),
            "state": "active" if c.get("state") == "active" else "inactive",
        })
    for a in rule.get("actions") or []:
        t = a.get("type")
        if t == "http_request":
            # method/url are stored as "" when omitted so _dispatch can fall
            # back to connections.ass_http (the simplified UI relies on this).
            raw_method = (a.get("method") or "").upper().strip()
            method = raw_method if raw_method in ("GET", "POST") else ""
            r["actions"].append({
                "type": "http_request",
                "method": method,
                "url": str(a.get("url", "")).strip(),
                "body": str(a.get("body") or ""),
            })
        elif t == "transition":
            r["actions"].append({
                "type": "transition",
                "transition_id": str(a.get("transition_id") or ""),
            })
        # unknown action types are dropped silently
    return r


class RuleEngine:
    """Evaluates rules against group activity each tick and drives output.

    Match semantics:
      - Rules walked in descending priority order.
      - First enabled rule whose ALL conditions are satisfied is the candidate.
      - Empty conditions list ⇒ always satisfied (catch-all rule).
      - Condition: group must currently be in the specified state.

    Switch semantics:
      - When the candidate differs from the active rule, switch only if
        `now - active_since >= active_rule.cooldown_s`. Cooldown is always
        honored; priority only decides which candidate wins among simultaneous
        matches, never bypasses an in-progress cooldown.

    Output semantics (per active rule's actions):
      - http_request : fired once on switch, then re-fired every `refire_s`
        as a self-healing heartbeat.
      - transition   : drives a macro rotation. A macro's token is POSTed ONLY
        when the on-air macro changes — once per draw (on rule activation and
        each rotation interval), never re-sent in between. With camera_alternate
        on, draws are two-level: cameras round-robin (each camera once per round,
        shuffled order, never the on-air camera twice in a row) and the scenes
        within a camera shuffle as that camera's own card-deck. This guarantees
        no consecutive same-camera cut and gives every camera equal airtime.
        interval_s=0 ⇒ a static shot fired exactly once.
        (http_request actions still use the refire_s heartbeat; transitions do not.)
    """

    LOG_MAX = 100
    DEFAULT_REFIRE_S = 3.0
    DEFAULT_INTERVAL_S = 8.0

    def __init__(self, config_store):
        self.config_store = config_store
        self.active_rule_id: str | None = None
        self.active_since: float = 0.0
        # rule_id -> next monotonic time at which an http_request refire fires.
        self._refire_at: dict[str, float] = {}
        # Rotation state for the active transition rule, or None. Shape:
        #   {rule_id, transition_id, deck_remaining[list], current_macro_id,
        #    current_camera, next_at, refire_at}
        self._rotation: dict[str, Any] | None = None
        self._action_log: deque[dict[str, Any]] = deque(maxlen=self.LOG_MAX)

    # ── Public ────────────────────────────────────────────────────

    def tick(self, group_states: dict[str, dict[str, Any]]) -> dict[str, Any]:
        cfg = self.config_store.snapshot()
        runtime = cfg.get("runtime") or {}
        rules: list[dict[str, Any]] = cfg.get("rules") or []
        dry_run: bool = bool(runtime.get("dry_run", True))
        auto: bool = bool(runtime.get("auto", True))
        refire_s: float = float(runtime.get("refire_s", self.DEFAULT_REFIRE_S))

        now = time.monotonic()

        if not auto:
            return {
                "active_rule_id": None,
                "active_rule_name": None,
                "fired": [],
                "reason": "manual",
            }

        ordered = sorted(
            [r for r in rules if r.get("enabled", True)],
            key=lambda r: (-int(r.get("priority", 0)),),
        )
        matching = [r for r in ordered if self._match(r, group_states)]
        candidate = matching[0] if matching else None
        fired: list[dict[str, Any]] = []

        # Decide whether to switch.
        switch_to: dict[str, Any] | None = None
        if candidate is None:
            if self.active_rule_id is not None:
                active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
                cooldown = float(active_rule.get("cooldown_s", 0.0)) if active_rule else 0.0
                if now - self.active_since >= cooldown:
                    self._release_active()
                    self.active_since = now
        else:
            cand_id = candidate["id"]
            if cand_id != self.active_rule_id:
                allow = True
                if self.active_rule_id is not None:
                    active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
                    cd = float(active_rule.get("cooldown_s", 0.0)) if active_rule else 0.0
                    if now - self.active_since < cd:
                        allow = False
                if allow:
                    switch_to = candidate

        if switch_to is not None:
            if self.active_rule_id is not None and self.active_rule_id != switch_to["id"]:
                self._refire_at.pop(self.active_rule_id, None)
            # Don't wipe rotation state here. _tick_rotation re-inits only when
            # the (rule, transition) actually differs (need_init). Keeping the
            # prior state lets the SAME rule, after a brief condition flap,
            # resume its deck + on-air camera memory instead of restarting with
            # an immediate off-cadence draw that ignores the last camera (which
            # produced visible same-camera repeats, e.g. cam3 → cam3).
            self.active_rule_id = switch_to["id"]
            self.active_since = now
            for action in switch_to.get("actions", []):
                if action["type"] == "http_request":
                    fired.append(self._fire(switch_to, action, dry_run, now, "transition"))
            if refire_s > 0:
                self._refire_at[switch_to["id"]] = now + refire_s

        # Drive the active rule's output (http refire + transition rotation).
        if self.active_rule_id is not None:
            active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
            if active_rule is None:
                # Rule was deleted while active.
                self._release_active()
            else:
                # http_request refire heartbeat
                if refire_s > 0:
                    next_at = self._refire_at.get(self.active_rule_id)
                    if next_at is None:
                        self._refire_at[self.active_rule_id] = now + refire_s
                    elif now >= next_at:
                        for action in active_rule.get("actions", []):
                            if action["type"] == "http_request":
                                fired.append(self._fire(active_rule, action, dry_run, now, "refire"))
                        self._refire_at[self.active_rule_id] = now + refire_s

                # transition rotation
                transition = self._resolve_transition(cfg, active_rule)
                if transition is not None:
                    self._tick_rotation(active_rule, transition, cfg, now, dry_run, fired)
                else:
                    self._rotation = None

        active_name = None
        active_rule_cooldown_remaining = None
        if self.active_rule_id is not None:
            active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
            if active_rule:
                active_name = active_rule.get("name")
                cd = float(active_rule.get("cooldown_s", 0.0))
                active_rule_cooldown_remaining = max(0.0, cd - (now - self.active_since))

        queue: list[dict[str, Any]] = []
        for r in matching:
            queue.append({
                "id": r["id"],
                "name": r.get("name"),
                "priority": int(r.get("priority", 0)),
                "is_active": r["id"] == self.active_rule_id,
                "preview": self._next_action_preview(cfg, r),
            })

        # ── Live "Director" info for the active transition rotation ──
        director: dict[str, Any] = {
            "transition_id": None, "transition_name": None,
            "current": None, "upcoming": [],
            "next_in": None, "interval": None,
        }
        rot = self._rotation
        if (self.active_rule_id is not None and rot
                and rot.get("rule_id") == self.active_rule_id):
            macro_index = self._macro_index(cfg)
            active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
            transition = self._resolve_transition(cfg, active_rule) if active_rule else None
            if transition is not None:
                cur_id = rot.get("current_macro_id")
                cur = macro_index.get(cur_id) if cur_id else None
                director["transition_id"] = transition.get("id")
                director["transition_name"] = transition.get("name")
                if cur is not None:
                    director["current"] = {
                        "macro_id": cur_id, "name": cur.get("name"),
                        "camera": cur.get("camera"),
                    }
                director["upcoming"] = self._predict(rot, transition, macro_index, 5)
                director["interval"] = round(
                    float(transition.get("interval_s", self.DEFAULT_INTERVAL_S)), 2)
                nxt = rot.get("next_at")
                if nxt is not None and nxt != float("inf"):
                    director["next_in"] = round(max(0.0, nxt - now), 2)

        return {
            "active_rule_id": self.active_rule_id,
            "active_rule_name": active_name,
            "active_cooldown_remaining": (
                round(active_rule_cooldown_remaining, 2)
                if active_rule_cooldown_remaining is not None else None
            ),
            "active_macro": (director["current"] or {}).get("macro_id"),
            "director": director,
            "fired": fired,
            "dry_run": dry_run,
            "matching": queue,
        }

    def recent_log(self, limit: int = 30) -> list[dict[str, Any]]:
        return list(self._action_log)[-limit:]

    def fire_manual(self, rule_id: str) -> dict[str, Any]:
        """Fire a rule's actions immediately, ignoring its conditions (for the
        UI "Run" test button). Honors dry_run; does NOT touch engine state.
        For a transition action, fires the first valid macro's token once."""
        cfg = self.config_store.snapshot()
        rule = next((r for r in (cfg.get("rules") or []) if r["id"] == rule_id), None)
        if rule is None:
            raise KeyError(rule_id)
        dry_run = bool((cfg.get("runtime") or {}).get("dry_run", True))
        now = time.monotonic()
        fired: list[dict[str, Any]] = []
        macro_index = self._macro_index(cfg)
        for action in rule.get("actions", []):
            if action["type"] == "http_request":
                fired.append(self._fire(rule, action, dry_run, now, cause="manual"))
            elif action["type"] == "transition":
                transition = self._resolve_transition(cfg, rule)
                if transition is None:
                    continue
                macro = next(
                    (macro_index[mid] for mid in transition.get("deck", []) if mid in macro_index),
                    None,
                )
                if macro is not None:
                    fired.append(self._fire_macro(rule, transition, macro, dry_run, now, "manual"))
        return {"rule_id": rule_id, "rule_name": rule.get("name"), "fired": fired, "dry_run": dry_run}

    # ── Internal: state ───────────────────────────────────────────

    def _release_active(self) -> None:
        # Note: rotation state is intentionally NOT cleared here. If the same
        # rule re-activates after a brief condition flap, it resumes its deck
        # and on-air camera memory (see _tick_rotation.need_init). A genuinely
        # different rule/transition re-inits on its own; a non-transition rule
        # clears rotation in the tick() drive block.
        if self.active_rule_id is not None:
            self._refire_at.pop(self.active_rule_id, None)
        self.active_rule_id = None

    def _match(self, rule: dict[str, Any], group_states: dict[str, dict[str, Any]]) -> bool:
        conditions = rule.get("conditions") or []
        if not conditions:
            return True  # catch-all
        for cond in conditions:
            group = cond.get("group")
            want_active = cond.get("state") == "active"
            g = group_states.get(group)
            if g is None:
                return False
            if bool(g.get("active")) != want_active:
                return False
        return True

    # ── Internal: transitions / rotation ──────────────────────────

    @staticmethod
    def _resolve_transition(cfg: dict[str, Any], rule: dict[str, Any]) -> dict[str, Any] | None:
        tid = None
        for a in rule.get("actions", []):
            if a.get("type") == "transition" and a.get("transition_id"):
                tid = a["transition_id"]
                break
        if not tid:
            return None
        for t in cfg.get("transitions") or []:
            if t.get("id") == tid:
                return t
        return None

    @staticmethod
    def _macro_index(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {m["id"]: m for m in (cfg.get("macros") or []) if m.get("id")}

    def _interval(self, transition: dict[str, Any]) -> float:
        base = float(transition.get("interval_s", self.DEFAULT_INTERVAL_S))
        if base <= 0:
            return 0.0  # 0 ⇒ no rotation (static single shot)
        jit = float(transition.get("jitter_s", 0.0))
        if jit > 0:
            base = base + random.uniform(-jit, jit)
        return max(0.5, base)

    @staticmethod
    def _camera_order(deck: list[str], macro_index: dict[str, dict[str, Any]]) -> list[Any]:
        """Distinct cameras present in the deck, in order of first appearance."""
        seen: set[Any] = set()
        cams: list[Any] = []
        for mid in deck:
            c = macro_index[mid].get("camera")
            if c not in seen:
                seen.add(c)
                cams.append(c)
        return cams

    def _draw_opening(self, rot: dict[str, Any], transition: dict[str, Any],
                      macro_index: dict[str, dict[str, Any]],
                      rng: random.Random | Any = random) -> dict[str, Any] | None:
        """Open a transition on its DESIGNATED first screen — the first macro
        in the deck — so a rule change cuts to a recognizable establishing shot
        rather than a random one. Then prime the bags so rotation continues
        cleanly (the opening camera won't immediately repeat)."""
        deck = [mid for mid in (transition.get("deck") or []) if mid in macro_index]
        if not deck:
            return None
        first = deck[0]
        macro = macro_index[first]
        cam = macro.get("camera")
        if not transition.get("camera_alternate", True):
            rest = [m for m in deck if m != first]
            rng.shuffle(rest)
            rot["flat_bag"] = rest
            rot["scene_bags"] = {}
            rot["cam_bag"] = []
        else:
            cam_scenes = [m for m in deck if macro_index[m].get("camera") == cam and m != first]
            rng.shuffle(cam_scenes)
            rot["scene_bags"] = {cam: cam_scenes}
            rot["cam_bag"] = []
            rot["flat_bag"] = []
        rot["current_macro_id"] = first
        rot["current_camera"] = cam
        # Commit the first post-opening round so the Director preview is exact.
        self._commit_next_round(rot, transition, macro_index, rng)
        return macro

    PREVIEW_HORIZON = 5

    def _commit_next_round(self, rot: dict[str, Any], transition: dict[str, Any],
                           macro_index: dict[str, dict[str, Any]],
                           rng: random.Random | Any) -> None:
        """Eager-commit several rounds ahead — the camera round-robin order plus
        the committed scene order for every camera occurrence — so the upcoming
        sequence is exactly predictable for the whole Director horizon (what
        _predict shows is what will fire), not just the immediate next shot."""
        if not transition.get("camera_alternate", True):
            return
        deck = [mid for mid in (transition.get("deck") or []) if mid in macro_index]
        cams = self._camera_order(deck, macro_index)
        if not cams:
            return

        # Camera buffer: top up to a couple rounds so the full preview horizon
        # is committed. Each appended round avoids repeating the prior camera.
        cam_bag = [c for c in (rot.get("cam_bag") or []) if c in cams]
        buffer_len = max(2 * len(cams), self.PREVIEW_HORIZON + 1)
        last = cam_bag[-1] if cam_bag else rot.get("current_camera")
        while len(cam_bag) < buffer_len:
            nb = list(cams)
            rng.shuffle(nb)
            if len(nb) > 1 and nb[0] == last:
                nb.append(nb.pop(0))
            cam_bag.extend(nb)
            last = nb[-1]

        # Scene buffers: each camera needs as many committed scenes as it occurs
        # in the camera buffer; extend by reshuffled full cycles (card-deck).
        from collections import Counter
        need = Counter(cam_bag)
        scene_bags: dict[Any, list[str]] = rot.get("scene_bags") or {}
        for c, k in need.items():
            cb = [mid for mid in (scene_bags.get(c) or [])
                  if mid in macro_index and macro_index[mid].get("camera") == c]
            cam_scenes = [mid for mid in deck if macro_index[mid].get("camera") == c]
            if not cam_scenes:
                cb = []
            while len(cb) < k:
                extra = list(cam_scenes)
                rng.shuffle(extra)
                cb.extend(extra)
            scene_bags[c] = cb
        rot["cam_bag"] = cam_bag
        rot["scene_bags"] = scene_bags

    def _draw_next(self, rot: dict[str, Any], transition: dict[str, Any],
                   macro_index: dict[str, dict[str, Any]],
                   rng: random.Random | Any = random) -> dict[str, Any] | None:
        """Pick the next macro using a TWO-LEVEL model:

          - Camera level (round-robin): each round visits every distinct camera
            in the deck exactly once, in a freshly shuffled order, with the
            first camera of a new round chosen so it never equals the on-air
            camera. This GUARANTEES no two consecutive shots share a camera
            (whenever the deck has ≥2 cameras), and gives every camera equal
            airtime regardless of how many scenes it has.
          - Scene level (per-camera shuffle): within the chosen camera, scenes
            are dealt from that camera's own card-deck — each of its scenes once
            before that camera reshuffles.

        Draw order is COMMITTED (bags shuffled once on refill, then consumed
        front-to-back), so the upcoming sequence is predictable for the live
        Director view. With camera_alternate off, falls back to a flat
        card-deck over all macros (camera may repeat).
        """
        deck = [mid for mid in (transition.get("deck") or []) if mid in macro_index]
        if not deck:
            return None

        if not transition.get("camera_alternate", True):
            bag = [mid for mid in (rot.get("flat_bag") or []) if mid in macro_index]
            if not bag:
                bag = list(deck)
                rng.shuffle(bag)
            choice = bag.pop(0)
            rot["flat_bag"] = bag
            macro = macro_index[choice]
            rot["current_macro_id"] = choice
            rot["current_camera"] = macro.get("camera")
            return macro

        cams = self._camera_order(deck, macro_index)
        scene_bags: dict[Any, list[str]] = rot.get("scene_bags") or {}

        # Pop the next camera (round-robin, committed order).
        cam_bag = [c for c in (rot.get("cam_bag") or []) if c in cams]
        if not cam_bag:
            cam_bag = list(cams)
            rng.shuffle(cam_bag)
            if len(cam_bag) > 1 and cam_bag[0] == rot.get("current_camera"):
                cam_bag.append(cam_bag.pop(0))
        cam = cam_bag.pop(0)

        # Pop the next scene within that camera (committed per-camera deck).
        bag = [mid for mid in (scene_bags.get(cam) or [])
               if mid in macro_index and macro_index[mid].get("camera") == cam]
        if not bag:
            bag = [mid for mid in deck if macro_index[mid].get("camera") == cam]
            rng.shuffle(bag)
        if not bag:
            return None  # camera has no scenes (shouldn't happen)
        choice = bag.pop(0)
        scene_bags[cam] = bag

        rot["cam_bag"] = cam_bag
        rot["scene_bags"] = scene_bags
        macro = macro_index[choice]
        rot["current_macro_id"] = choice
        rot["current_camera"] = cam
        # Commit the next round so the upcoming sequence stays exactly known.
        self._commit_next_round(rot, transition, macro_index, rng)
        return macro

    def _predict(self, rot: dict[str, Any], transition: dict[str, Any],
                 macro_index: dict[str, dict[str, Any]], n: int) -> list[dict[str, Any]]:
        """Look ahead n shots WITHOUT mutating live state. Seeded from the
        committed bag state so the result is stable across ticks (it only
        shifts when a real shot fires). The immediate next shots are exact
        (committed); shots beyond a bag refill are a representative sample."""
        if not rot:
            return []
        seed = hash((
            rot.get("current_macro_id"),
            tuple(rot.get("cam_bag") or []),
            tuple(sorted((str(k), tuple(v)) for k, v in (rot.get("scene_bags") or {}).items())),
            tuple(rot.get("flat_bag") or []),
        ))
        rng = random.Random(seed)
        sim = {
            "cam_bag": list(rot.get("cam_bag") or []),
            "scene_bags": {k: list(v) for k, v in (rot.get("scene_bags") or {}).items()},
            "flat_bag": list(rot.get("flat_bag") or []),
            "current_macro_id": rot.get("current_macro_id"),
            "current_camera": rot.get("current_camera"),
        }
        out: list[dict[str, Any]] = []
        for _ in range(n):
            m = self._draw_next(sim, transition, macro_index, rng=rng)
            if m is None:
                break
            out.append({"macro_id": m["id"], "name": m.get("name"), "camera": m.get("camera")})
        return out

    def preview_transition(self, transition: dict[str, Any],
                           macro_index: dict[str, dict[str, Any]], n: int) -> list[dict[str, Any]]:
        """A representative upcoming sequence for an idle transition (opening
        shot first, then rotation). Seeded by transition id so reopening the
        preview is stable."""
        rng = random.Random(hash(("preview", transition.get("id"))))
        rot: dict[str, Any] = {
            "cam_bag": [], "scene_bags": {}, "flat_bag": [],
            "current_macro_id": None, "current_camera": None,
        }
        out: list[dict[str, Any]] = []
        m = self._draw_opening(rot, transition, macro_index, rng=rng)
        while m is not None and len(out) < n:
            out.append({"macro_id": m["id"], "name": m.get("name"),
                        "camera": m.get("camera"),
                        "opening": len(out) == 0})
            m = self._draw_next(rot, transition, macro_index, rng=rng)
        return out

    def _tick_rotation(self, rule: dict[str, Any], transition: dict[str, Any],
                       cfg: dict[str, Any], now: float, dry_run: bool,
                       fired: list[dict[str, Any]]) -> None:
        """Fire a macro ONLY when the on-air macro changes — i.e. once per draw
        (rule activation / re-init, and each rotation interval). The current
        macro's token is NOT periodically re-sent; a static transition
        (interval_s=0) therefore fires exactly once and then holds."""
        macro_index = self._macro_index(cfg)
        rot = self._rotation
        need_init = (
            rot is None
            or rot.get("rule_id") != rule["id"]
            or rot.get("transition_id") != transition.get("id")
        )

        def schedule_next() -> None:
            interval = self._interval(transition)
            rot["next_at"] = (now + interval) if interval > 0 else float("inf")

        if need_init:
            self._rotation = rot = {
                "rule_id": rule["id"],
                "transition_id": transition.get("id"),
                "cam_bag": [],       # camera round-robin queue
                "scene_bags": {},    # camera -> remaining scene ids
                "flat_bag": [],      # used only when camera_alternate is off
                "current_macro_id": None,
                "current_camera": None,
                "next_at": now,
            }
            # Open on the transition's designated first screen (deck[0]).
            macro = self._draw_opening(rot, transition, macro_index)
            if macro is not None:
                fired.append(self._fire_macro(rule, transition, macro, dry_run, now, "rotation"))
            schedule_next()
            return

        if now >= rot["next_at"]:
            macro = self._draw_next(rot, transition, macro_index)
            if macro is not None:
                fired.append(self._fire_macro(rule, transition, macro, dry_run, now, "rotation"))
            schedule_next()

    # ── Internal: firing / dispatch ───────────────────────────────

    def _fire(self, rule: dict[str, Any], action: dict[str, Any],
              dry_run: bool, now: float, cause: str,
              detail: str | None = None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        evt = {
            "ts": now,
            "wall_ts": time.time(),
            "rule_id": rule["id"],
            "rule_name": rule.get("name"),
            "type": action["type"],
            "detail": detail if detail is not None else self._action_detail(action),
            "dry_run": dry_run,
            "cause": cause,
            "dispatched": False,
            "dispatch_error": None,
        }
        if extra:
            evt.update(extra)
        if not dry_run:
            try:
                evt["dispatched"] = self._dispatch(action) or False
            except Exception as e:
                evt["dispatch_error"] = str(e)
        self._action_log.append(evt)
        return evt

    def _fire_macro(self, rule: dict[str, Any], transition: dict[str, Any],
                    macro: dict[str, Any], dry_run: bool, now: float, cause: str) -> dict[str, Any]:
        token = str(macro.get("token") or "")
        action = {"type": "http_request", "method": "", "url": "", "body": token}
        cam = macro.get("camera")
        cam_str = f" (cam{cam})" if cam not in (None, "") else ""
        detail = f"macro → {macro.get('name') or token}{cam_str} · {transition.get('name', '')}"
        return self._fire(rule, action, dry_run, now, cause, detail=detail, extra={
            "macro_id": macro.get("id"),
            "macro_name": macro.get("name"),
            "camera": cam,
            "transition_id": transition.get("id"),
            "transition_name": transition.get("name"),
            "token": token,
        })

    def _dispatch(self, action: dict[str, Any]) -> bool:
        """Send the http_request action. Returns True if dispatched (fired on a
        daemon thread; success means 'sent')."""
        if action["type"] != "http_request":
            return False
        url = (action.get("url") or "").strip()
        method = (action.get("method") or "").upper().strip()
        if not url or not method:
            ass = (self.config_store.snapshot()
                   .get("connections", {})
                   .get("ass_http", {}))
            if not url:
                url = (ass.get("url") or "").strip()
            if not method:
                method = (ass.get("method") or "POST").upper()
        if not url:
            return False
        body = (action.get("body") or "").encode("utf-8") if method == "POST" else None
        threading.Thread(
            target=self._do_http,
            args=(method, url, body),
            daemon=True,
            name="http-dispatch",
        ).start()
        return True

    def _next_action_preview(self, cfg: dict[str, Any], rule: dict[str, Any]) -> str:
        """Short description of what this rule's first action would emit."""
        actions = rule.get("actions") or []
        if not actions:
            return "(no actions)"
        a = actions[0]
        if a.get("type") == "transition":
            t = self._resolve_transition(cfg, rule)
            if t is None:
                return "transition: (없음)"
            n = len([m for m in (t.get("deck") or [])])
            return f"transition: {t.get('name', '?')} · {n}장"
        body = a.get("body") or ""
        if len(body) > 40:
            body = body[:38] + "…"
        return f"HTTP body: {body}" if body else "HTTP (no body)"

    @staticmethod
    def _action_detail(action: dict[str, Any]) -> str:
        if action.get("type") == "transition":
            return f"transition → {action.get('transition_id', '')}"
        url = action.get("url") or "(global)"
        method = action.get("method") or "POST"
        body = action.get("body") or ""
        suffix = f" · {body}" if body else ""
        return f"HTTP {method} → {url}{suffix}"

    @staticmethod
    def _do_http(method: str, url: str, body: bytes | None) -> None:
        try:
            req = urllib.request.Request(url, data=body, method=method)
            if body is not None:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=3) as resp:
                resp.read(0)  # drain quickly; we don't care about the body
        except (urllib.error.URLError, OSError, ValueError) as e:
            logger.warning("http_request failed: %s %s — %s", method, url, e)
