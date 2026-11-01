from __future__ import annotations

import logging
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from typing import Any

from .config import (
    PACE_SECONDS,
    SCENE_HOLD_S,
    SUBJECT_WIDE,
    default_profile,
    split_subject,
)

logger = logging.getLogger(__name__)


def new_rule_id() -> str:
    return "rule_" + uuid.uuid4().hex[:8]


def default_rule() -> dict[str, Any]:
    return {
        "id": new_rule_id(),
        "name": "새 장면",
        "priority": 0,
        "enabled": True,
        "conditions": [],          # [] = always match (catch-all)
        "profile": default_profile(),
    }


def normalize_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """Ensure a scene has all required fields with valid types.

    A scene says only WHEN it applies and WHO it may cover. How it is shot is
    one algorithm shared by every scene, so there is nothing else to store.
    """
    return {
        "id": rule.get("id") or new_rule_id(),
        "name": str(rule.get("name") or "새 장면"),
        "priority": int(rule.get("priority", 0)),
        "enabled": bool(rule.get("enabled", True)),
        "conditions": [
            {
                "group": str(c.get("group", "")),
                "state": "active" if c.get("state") == "active" else "inactive",
            }
            for c in (rule.get("conditions") or [])
        ],
        "profile": rule.get("profile") if isinstance(rule.get("profile"), dict)
                   else default_profile(),
    }


class RuleEngine:
    """Decides what is on air, in two layers.

    SCENE (slow): rules are walked in descending priority; the first enabled
    rule whose conditions all hold frames the scene, and an empty condition list
    is a catch-all. A scene holds SCENE_HOLD_S past its conditions so a source
    that flaps cannot whip the show around. With nothing matching (or in
    "dynamic" mode, which skips rules) the runtime's default scene applies.

    SHOT (fast): one algorithm, the same in every scene, built from three rules
    in priority order:

      1. Never cut a camera to itself. This is a hard filter, not a penalty —
         a cut from a camera back to the same camera reads as a glitch rather
         than an edit, so a candidate that would do it is simply not eligible.
      2. Visit every live subject. Subjects sit in a rotation queue and go to
         the back when aired, so airtime is shared instead of chasing whoever
         is loudest. A subject that rule 1 blocks keeps its place at the front
         and is picked up on the very next cut.
      3. Cut on the beat. Shot length is a musical duration — the pace target
         rounded to a whole number of beats, preferring whole bars — and cuts
         land on the tracked beat grid. With no beat detected (speech, or a band
         with no drums) the same target is used as plain seconds.

    Deriving the beat count from a duration rather than fixing it makes pacing
    immune to the tempo tracker's octave errors: if the reported tempo doubles,
    the beat count doubles with it and the shot stays the same length.

    Only one thing interrupts the rotation: a subject that was not live at the
    last cut and has now sustained for INTERRUPT_MIN_ACTIVE_S jumps to the front
    of the queue and cuts on the next beat rather than the next scheduled cut.
    That is what puts the pastor on screen when he starts talking, while the
    sustain requirement keeps a cough or a bumped mic from doing the same.

    A shot's token is POSTed only when the on-air shot CHANGES, never on a
    timer, so a held frame is never re-triggered.
    """

    LOG_MAX = 100
    SHOT_RULE_ID = "__shot__"        # operator pinned a single shot
    DEFAULT_RULE_ID = "__default__"  # no scene matched → runtime default scene

    PREVIEW_HORIZON = 5
    # A newly live subject must sustain this long before it may interrupt.
    INTERRUPT_MIN_ACTIVE_S = 0.8
    # ...and no shot is ever cut sooner than this, interrupt or not.
    MIN_SHOT_S = 2.5
    # A subject that was on air this recently is not "new" when it comes back.
    # Without this, a singer who pauses for a breath leaves the active set and
    # returns as a fresh arrival, so the show cuts away from them and straight
    # back — twice, for one breath.
    INTERRUPT_MIN_OFFAIR_S = 8.0
    # How close to a beat line an interrupting cut must land.
    ON_BEAT_WINDOW_S = 0.08
    # Beat counts considered for a shot; multiples of 4 are whole bars and are
    # preferred, so cuts land on bar lines whenever that is close to the target.
    BEAT_CHOICES = tuple(range(2, 33, 2))
    BAR_BONUS = 0.15                 # relative pull toward whole bars

    def __init__(self, config_store, audio=None):
        self.config_store = config_store
        self.audio = audio           # provides .beat; None in tests
        self.active_rule_id: str | None = None
        self.active_since: float = 0.0
        # On-air shot: {macro_id, subjects, camera, since, cut_at, cause}
        self._shot: dict[str, Any] | None = None
        self._queue: list[str] = []          # rotation order, front = next up
        self._last_shot_for: dict[str, str] = {}   # subject -> last macro aired
        self._last_on_air: dict[str, float] = {}   # subject -> when it last aired
        self._active_at_cut: set[str] = set()
        self._scene_open: bool = False
        self._action_log: deque[dict[str, Any]] = deque(maxlen=self.LOG_MAX)

    # ── Public ────────────────────────────────────────────────────

    def tick(self, group_states: dict[str, dict[str, Any]],
             role_states: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        cfg = self.config_store.snapshot()
        runtime = cfg.get("runtime") or {}
        dry_run: bool = bool(runtime.get("dry_run", True))
        auto: bool = bool(runtime.get("auto", True))
        override_rule_id = runtime.get("override_rule_id") or None
        override_macro_id = runtime.get("override_macro_id") or None
        director_mode = "dynamic" if runtime.get("director_mode") == "dynamic" else "rules"
        pace = runtime.get("pace") or "normal"
        now = time.monotonic()

        activity = self.activity(group_states, role_states)
        macro_index = self._macro_index(cfg)
        beat = self._beat_snapshot(now)

        if not auto:
            self._reset()
            self.active_rule_id = None
            return self._payload(cfg, None, [], dry_run, director_mode, activity,
                                 beat, reason="manual")

        if override_macro_id and override_macro_id in macro_index:
            return self._tick_pinned_shot(macro_index[override_macro_id], now,
                                          dry_run, director_mode, activity, beat)

        rule, pinned = self._resolve_scene(cfg, activity, now,
                                           override_rule_id, director_mode)
        scene_id = rule["id"] if rule else self.DEFAULT_RULE_ID
        profile = (rule.get("profile") if rule else None) or runtime.get("profile") \
            or default_profile()

        if self.active_rule_id != scene_id:
            self.active_rule_id = scene_id
            self.active_since = now
            self._scene_open = True

        fired: list[dict[str, Any]] = []
        self._tick_shot(profile, activity, macro_index, now, pace, beat,
                        dry_run, fired, rule, self.subject_order(cfg))

        return self._payload(cfg, rule, fired, dry_run, director_mode, activity,
                             beat, pinned=pinned, now=now, macro_index=macro_index,
                             profile=profile, pace=pace)

    def recent_log(self, limit: int = 30) -> list[dict[str, Any]]:
        return list(self._action_log)[-limit:]

    def upcoming(self, profile: dict[str, Any], activity: dict[str, dict[str, Any]],
                 macro_index: dict[str, dict[str, Any]], n: int,
                 order: dict[str, int] | None = None) -> list[dict[str, Any]]:
        """What will actually fire next, continuing the LIVE rotation.

        Seeded from the real state — the rotation queue as it stands, the
        camera currently on air, and which angle each subject last used — so
        the first entry is precisely what the next cut will take if the room
        does not change. Re-derived every tick, so it follows the audio.
        """
        eligible = self._eligible(profile, macro_index, order)
        active = self._active_subjects(eligible, activity)
        return self._simulate(self._queue, active, eligible,
                              (self._shot or {}).get("camera"), self._last_shot_for, n)

    def preview_profile(self, cfg: dict[str, Any], profile: dict[str, Any],
                        activity: dict[str, dict[str, Any]], n: int) -> list[dict[str, Any]]:
        """The sequence this scene would run if it opened FRESH, against the
        current activity — for the scene editor, which is asking "what would
        this scene do", not "what happens next". Starts from nothing on air,
        which is why it must not reuse the live rotation state."""
        macro_index = self._macro_index(cfg)
        eligible = self._eligible(profile, macro_index, self.subject_order(cfg))
        active = self._active_subjects(eligible, activity)
        return self._simulate(self._ordered_subjects(eligible), active, eligible,
                              None, {}, n)

    def _simulate(self, queue: list[str], active: set[str],
                  eligible: dict[str, list[dict[str, Any]]], last_camera: Any,
                  last_shot_for: dict[str, str], n: int) -> list[dict[str, Any]]:
        """Run the draw forward n times without touching live state."""
        queue = list(queue)
        last_shot = dict(last_shot_for)
        out: list[dict[str, Any]] = []
        for _ in range(n):
            pick = self._draw(queue, active, eligible, last_camera, last_shot)
            if pick is None:
                break
            subject, macro = pick
            queue.remove(subject)
            queue.append(subject)
            last_shot[subject] = macro["id"]
            last_camera = macro.get("camera")
            out.append(self._shot_info(macro) | {"subject": subject})
        return out

    # ── Scene resolution ──────────────────────────────────────────

    def _resolve_scene(self, cfg: dict[str, Any], activity: dict[str, dict[str, Any]],
                       now: float, override_rule_id: str | None,
                       director_mode: str) -> tuple[dict[str, Any] | None, bool]:
        rules: list[dict[str, Any]] = cfg.get("rules") or []

        if override_rule_id:
            pinned = next((r for r in rules if r.get("id") == override_rule_id), None)
            if pinned is not None:
                return pinned, True   # a pin ignores conditions AND the hold

        if director_mode == "dynamic":
            return None, False

        states = self._match_states(activity)
        ordered = sorted([r for r in rules if r.get("enabled", True)],
                         key=lambda r: -int(r.get("priority", 0)))
        candidate = next((r for r in ordered if self._match(r, states)), None)
        candidate_id = candidate["id"] if candidate else self.DEFAULT_RULE_ID
        if candidate_id == self.active_rule_id:
            return candidate, False

        # The active scene holds the floor for SCENE_HOLD_S. Priority decides
        # who wins among simultaneous matches; it never cuts the hold short.
        #
        # The hold covers the DEFAULT scene as well. Looking the active scene up
        # in `rules` and bailing out when it is missing quietly exempted the
        # default one — nothing carries its id — so a scene whose conditions
        # flickered would bounce rule → default → rule within a second, and each
        # bounce forced its own cut.
        #
        # The length comes from the scene that currently holds the floor, not
        # from the one trying to take it: it is that scene saying how long it
        # needs, and it outranks priority for exactly that long.
        held = next((r for r in rules if r.get("id") == self.active_rule_id), None)
        if self.active_rule_id is not None \
                and now - self.active_since < self._scene_hold(cfg, held):
            return held, False
        return candidate, False

    @staticmethod
    def _scene_hold(cfg: dict[str, Any], rule: dict[str, Any] | None) -> float:
        """How long the scene now on the floor must keep it."""
        profile = (rule or {}).get("profile") \
            or (cfg.get("runtime") or {}).get("profile") or {}
        try:
            return max(0.0, float(profile.get("hold_s", SCENE_HOLD_S)))
        except (TypeError, ValueError):
            return SCENE_HOLD_S

    @staticmethod
    def _match_states(activity: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Conditions name a bare TEAM or ROLE, not a subject key. Teams are
        applied last so a team wins any name collision."""
        states: dict[str, dict[str, Any]] = {}
        for wanted in ("role", "team"):
            for key, st in activity.items():
                kind, name = split_subject(key)
                if kind == wanted:
                    states[name] = st
        return states

    @staticmethod
    def _match(rule: dict[str, Any], states: dict[str, dict[str, Any]]) -> bool:
        conditions = rule.get("conditions") or []
        if not conditions:
            return True  # catch-all
        for cond in conditions:
            st = states.get(cond.get("group"))
            if st is None:
                return False
            if bool(st.get("active")) != (cond.get("state") == "active"):
                return False
        return True

    # ── Activity ──────────────────────────────────────────────────

    def activity(self, group_states: dict[str, dict[str, Any]],
                 role_states: dict[str, dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
        """Flatten both taxonomy levels into one subject-keyed table."""
        out: dict[str, dict[str, Any]] = {}
        for prefix, table in (("role", role_states), ("team", group_states)):
            for name, st in (table or {}).items():
                out[f"{prefix}:{name}"] = {
                    "active": bool(st.get("active")),
                    "active_for": float(st.get("active_for") or 0.0),
                    "peak_db": st.get("peak_db"),
                }
        return out

    # ── Shot layer ────────────────────────────────────────────────

    def _reset(self) -> None:
        self._shot = None
        self._scene_open = False
        self._queue = []
        self._last_on_air = {}

    @staticmethod
    def _firable(macro: dict[str, Any]) -> bool:
        """A shot with no token sends nothing, so airing it would leave the
        previous camera up while every readout claims we cut."""
        return bool((macro.get("token") or "").strip())

    @staticmethod
    def subject_order(cfg: dict[str, Any]) -> dict[str, int]:
        """Rank every subject by the order the operator arranged it in setup.

        The rotation seeds itself from this, so "reorder the roles" and "change
        who comes first on screen" are the same action. Without it the seed
        order fell out of whatever order the SHOTS happened to be in, which is
        not something anyone arranges deliberately.
        """
        groups = cfg.get("groups") or {}
        roles = cfg.get("roles") or {}
        keys = [SUBJECT_WIDE]
        for g in groups:
            keys.append(f"team:{g}")
            keys += [f"role:{r}" for r, m in roles.items() if (m or {}).get("group") == g]
        keys += [f"role:{r}" for r, m in roles.items()
                 if (m or {}).get("group") not in groups]
        return {k: i for i, k in enumerate(keys)}

    def _eligible(self, profile: dict[str, Any],
                  macro_index: dict[str, dict[str, Any]],
                  order: dict[str, int] | None = None) -> dict[str, list[dict[str, Any]]]:
        """subject -> its usable shots for this scene.

        Two independent filters: `who` limits which subjects may appear, and
        `cameras` limits which cameras the whole scene may use. Either being
        empty means "no limit". A subject left with no shot after filtering is
        dropped rather than kept empty, so it never takes a slot in the
        rotation that it cannot fill.
        """
        who = set(profile.get("who") or ())
        cams = set(profile.get("cameras") or ())
        out: dict[str, list[dict[str, Any]]] = {}
        for m in macro_index.values():
            if not self._firable(m):
                continue
            cam = "" if m.get("camera") is None else str(m["camera"])
            if cams and cam not in cams:
                continue
            for s in (m.get("subjects") or []):
                if who and s not in who:
                    continue
                out.setdefault(s, []).append(m)
        if order:
            # Unknown subjects (a shot pointing at a deleted role) sort last
            # rather than disappearing, so they stay visible as a problem.
            out = {k: out[k] for k in sorted(out, key=lambda x: order.get(x, 1 << 20))}
        return out

    @staticmethod
    def _active_subjects(eligible: dict[str, list[dict[str, Any]]],
                         activity: dict[str, dict[str, Any]]) -> set[str]:
        """Subjects that may be cut to right now.

        WIDE counts as always live: it is a framing, not a person, so there is
        nothing for it to be quiet about — and it is what keeps the rotation
        from emptying when the room goes silent.
        """
        live = {s for s in eligible
                if s == SUBJECT_WIDE or (activity.get(s) or {}).get("active")}
        return live

    @staticmethod
    def _ordered_subjects(eligible: dict[str, list[dict[str, Any]]]) -> list[str]:
        """Stable seed order for the queue: shots come out of the library in a
        fixed order, so a fresh queue is reproducible rather than arbitrary."""
        return list(eligible.keys())

    def _sync_queue(self, eligible: dict[str, list[dict[str, Any]]]) -> None:
        """Keep the rotation in step with the scene without disturbing it.

        Subjects are appended and removed in place rather than rebuilt, so a
        scene change or a re-assignment does not reset whose turn it is — the
        rotation is the only memory of who has and has not been on screen.
        """
        known = set(self._queue)
        for s in self._ordered_subjects(eligible):
            if s not in known:
                self._queue.append(s)
        self._queue = [s for s in self._queue if s in eligible]

    def _tick_shot(self, profile: dict[str, Any], activity: dict[str, dict[str, Any]],
                   macro_index: dict[str, dict[str, Any]], now: float, pace: str,
                   beat: dict[str, Any], dry_run: bool,
                   fired: list[dict[str, Any]], rule: dict[str, Any] | None,
                   order: dict[str, int]) -> None:
        eligible = self._eligible(profile, macro_index, order)
        self._sync_queue(eligible)
        active = self._active_subjects(eligible, activity)
        if not active:
            return   # nothing shootable → hold the frame rather than cut to black

        cause = self._cut_due(now, pace, beat, activity, active, eligible)
        if cause is None:
            return

        # An interrupting subject goes to the front so the cut lands on them.
        if cause == "interrupt":
            newly = self._newly_sustained(activity, active, now)
            if newly and newly in self._queue:
                self._queue.remove(newly)
                self._queue.insert(0, newly)

        last_cam = (self._shot or {}).get("camera")
        pick = self._draw(self._queue, active, eligible, last_cam, self._last_shot_for)
        if pick is None:
            return   # every live subject is blocked by the camera rule → hold
        subject, macro = pick
        self._queue.remove(subject)
        self._queue.append(subject)
        self._last_shot_for[subject] = macro["id"]
        self._commit(macro, subject, now, pace, beat, dry_run, fired, rule, cause)
        self._active_at_cut = set(active)

    def _draw(self, queue: list[str], active: set[str],
              eligible: dict[str, list[dict[str, Any]]], last_camera: Any,
              last_shot_for: dict[str, str]) -> tuple[str, dict[str, Any]] | None:
        """First subject in the queue that is live AND has a shot on a camera
        other than the one on air. Subjects failing either test are stepped over
        WITHOUT losing their place, so the camera rule delays a subject by one
        cut rather than costing them their turn."""
        for subject in queue:
            if subject not in active:
                continue
            shots = [m for m in eligible.get(subject, ())
                     if last_camera is None or m.get("camera") != last_camera]
            if not shots:
                continue
            # Within a subject, the angle that has been off screen longest.
            last = last_shot_for.get(subject)
            fresh = [m for m in shots if m["id"] != last]
            return subject, (fresh or shots)[0]
        return None

    @staticmethod
    def _shot_allowed(shot: dict[str, Any], active: set[str],
                      eligible: dict[str, list[dict[str, Any]]]) -> bool:
        """Is the on-air frame still a legal choice — right subject list, right
        cameras, and its subject still making sound?"""
        mid = shot.get("macro_id")
        return any(m["id"] == mid for s in active for m in eligible.get(s, ()))

    def _newly_sustained(self, activity: dict[str, dict[str, Any]],
                         active: set[str], now: float) -> str | None:
        """A subject worth interrupting for: not live at the last cut, up long
        enough to be real rather than a blip, and not one we were just showing.

        The last clause is what separates "someone new started" from "someone
        paused for a breath". Both look identical in the active set — the
        subject disappears and comes back — so without the off-air test the
        show cuts away from a singer and immediately back to them.
        """
        for s in active - self._active_at_cut:
            st = activity.get(s) or {}
            if float(st.get("active_for", 0.0)) < self.INTERRUPT_MIN_ACTIVE_S:
                continue
            last = self._last_on_air.get(s)
            if last is not None and now - last < self.INTERRUPT_MIN_OFFAIR_S:
                continue
            return s
        return None

    # ── Cut timing ────────────────────────────────────────────────

    def _beats_for(self, target_s: float, period: float) -> int:
        """Whole beats closest to the pace target, preferring whole bars."""
        return min(
            self.BEAT_CHOICES,
            key=lambda b: abs(b * period - target_s) + (self.BAR_BONUS * target_s if b % 4 else 0.0),
        )

    def _cut_due(self, now: float, pace: str, beat: dict[str, Any],
                 activity: dict[str, dict[str, Any]], active: set[str],
                 eligible: dict[str, list[dict[str, Any]]]) -> str | None:
        if self._shot is None:
            return "open"

        # A scene change forces a cut only when the frame it inherited is no
        # longer allowed. Cutting on every change meant a scene that merely
        # flickered threw away a perfectly good shot — and since the flicker
        # came back a beat later, the show cut twice in under a second and the
        # camera before the flicker returned looking like a repeat.
        if self._scene_open:
            if self._shot_allowed(self._shot, active, eligible):
                self._scene_open = False        # nothing to do; keep rolling
            elif now - self._shot["since"] < self.MIN_SHOT_S:
                return None                     # the floor binds here too
            else:
                return "open"

        cut_at = self._shot.get("cut_at")
        if cut_at is not None and now >= cut_at:
            return "cadence"
        # Someone new came up mid-shot: take the next beat rather than waiting
        # out the rest of this shot. The floor stops an interrupt from cutting
        # a frame that has barely been up.
        if now - self._shot["since"] >= self.MIN_SHOT_S \
                and self._newly_sustained(activity, active, now) \
                and self._on_beat(beat, now):
            return "interrupt"
        return None

    def _schedule(self, now: float, pace: str, beat: dict[str, Any],
                  macro: dict[str, Any]) -> tuple[float, int | None]:
        """When the shot just taken should end, and over how many beats.

        The grid point is taken from HALF a span ahead, not from `now`. The
        tempo tracker keeps re-estimating, so its phase drifts a little; asking
        for "the next grid point after now" can therefore return one only
        milliseconds away — which fires a second cut immediately after the one
        we just made. Aiming half a span out puts the answer in (0.5, 1.5]
        spans, absorbing any drift while keeping the average on target.
        """
        target = PACE_SECONDS.get(pace, PACE_SECONDS["normal"])
        period = beat.get("period")
        if beat.get("locked") and period:
            beats = self._beats_for(target, period)
            span = beats * period
            grid = self._next_grid(beat, now + span * 0.5, beats)
            if grid is not None:
                return grid, beats
        return now + target, None

    def _on_beat(self, beat: dict[str, Any], now: float) -> bool:
        """True just after a beat line. Used to place an interrupting cut on
        the music instead of wherever the trigger happened to land."""
        period = beat.get("period")
        if not beat.get("locked") or not period:
            return True   # no beat to wait for — cut straight away
        nxt = self._next_grid(beat, now, 1)
        if nxt is None:
            return True
        return (now - (nxt - period)) <= self.ON_BEAT_WINDOW_S

    def _next_grid(self, beat: dict[str, Any], after: float, beats: int) -> float | None:
        tracker = getattr(self.audio, "beat", None) if self.audio else None
        if tracker is None or not beat.get("locked"):
            return None
        return tracker.next_grid_after(after, beats)

    def _beat_snapshot(self, now: float) -> dict[str, Any]:
        tracker = getattr(self.audio, "beat", None) if self.audio else None
        if tracker is None:
            return {"locked": False, "bpm": None, "confidence": 0.0,
                    "period": None, "onsets": 0}
        return tracker.snapshot(now)

    # ── Committing a shot ─────────────────────────────────────────

    def _commit(self, macro: dict[str, Any], subject: str, now: float, pace: str,
                beat: dict[str, Any], dry_run: bool, fired: list[dict[str, Any]],
                rule: dict[str, Any] | None, cause: str) -> None:
        cut_at, beats = self._schedule(now, pace, beat, macro)
        self._shot = {
            "macro_id": macro["id"],
            "subject": subject,
            "subjects": macro.get("subjects") or [],
            "camera": macro.get("camera"),
            "since": now,
            "cut_at": cut_at,
            "beats": beats,
            "cause": cause,
        }
        self._scene_open = False
        for s in {subject, *(macro.get("subjects") or [])}:
            if s:
                self._last_on_air[s] = now
        fired.append(self._fire_macro(rule, macro, dry_run, now, cause))

    # ── Payload ───────────────────────────────────────────────────

    @staticmethod
    def _shot_info(macro: dict[str, Any]) -> dict[str, Any]:
        return {
            "macro_id": macro["id"],
            "name": macro.get("name"),
            "camera": macro.get("camera"),
            "subjects": macro.get("subjects") or [],
        }

    @staticmethod
    def _empty_director() -> dict[str, Any]:
        return {
            "scene_id": None, "scene_name": None, "current": None, "upcoming": [],
            "next_in": None, "interval": None, "active_subjects": [],
            "queue": [], "cause": None, "beats": None, "held": False,
            "hold_s": None, "hold_left": None,
        }

    def _tick_pinned_shot(self, macro: dict[str, Any], now: float, dry_run: bool,
                          director_mode: str, activity: dict[str, dict[str, Any]],
                          beat: dict[str, Any]) -> dict[str, Any]:
        fired: list[dict[str, Any]] = []
        if self.active_rule_id != self.SHOT_RULE_ID or not self._shot \
                or self._shot["macro_id"] != macro["id"]:
            self.active_rule_id = self.SHOT_RULE_ID
            self.active_since = now
            self._shot = {
                "macro_id": macro["id"], "subject": None,
                "subjects": macro.get("subjects") or [], "camera": macro.get("camera"),
                "since": now, "cut_at": None, "beats": None, "cause": "manual",
            }
            fired.append(self._fire_macro({"id": self.SHOT_RULE_ID, "name": "수동 샷"},
                                          macro, dry_run, now, "manual"))
        director = self._empty_director() | {
            "scene_id": self.SHOT_RULE_ID, "scene_name": "수동 샷",
            "current": self._shot_info(macro), "held": True, "cause": "manual",
            "active_subjects": sorted(s for s, st in activity.items() if st["active"]),
        }
        return {
            "active_rule_id": self.SHOT_RULE_ID, "active_rule_name": "수동 샷",
            "active_macro": macro["id"], "override_rule_id": None,
            "override_macro_id": macro["id"], "director": director, "fired": fired,
            "dry_run": dry_run, "matching": [], "director_mode": director_mode,
            "pinned": False, "beat": beat,
        }

    def _payload(self, cfg: dict[str, Any], rule: dict[str, Any] | None,
                 fired: list[dict[str, Any]], dry_run: bool, director_mode: str,
                 activity: dict[str, dict[str, Any]], beat: dict[str, Any],
                 pinned: bool = False, reason: str | None = None,
                 now: float | None = None,
                 macro_index: dict[str, dict[str, Any]] | None = None,
                 profile: dict[str, Any] | None = None,
                 pace: str = "normal") -> dict[str, Any]:
        director = self._empty_director()
        director["active_subjects"] = sorted(s for s, st in activity.items() if st["active"])
        scene_name = (rule.get("name") or "(이름 없음)") if rule else "기본 장면"

        if profile is not None and now is not None:
            macro_index = macro_index or self._macro_index(cfg)
            director |= {
                "scene_id": rule["id"] if rule else self.DEFAULT_RULE_ID,
                "scene_name": scene_name,
                "queue": list(self._queue),
                "hold_s": round(float((profile or {}).get("hold_s", SCENE_HOLD_S)), 1),
                "hold_left": round(max(0.0, float((profile or {}).get("hold_s", SCENE_HOLD_S))
                                       - (now - self.active_since)), 1),
            }
            shot = self._shot
            if shot and shot["macro_id"] in macro_index:
                macro = macro_index[shot["macro_id"]]
                cut_at = shot.get("cut_at")
                director |= {
                    "current": self._shot_info(macro) | {"subject": shot.get("subject")},
                    "cause": shot.get("cause"),
                    "beats": shot.get("beats"),
                    "interval": (round(cut_at - shot["since"], 2) if cut_at else None),
                    "next_in": (round(max(0.0, cut_at - now), 2) if cut_at else None),
                }
                director["upcoming"] = self.upcoming(
                    profile, activity, macro_index, self.PREVIEW_HORIZON,
                    self.subject_order(cfg))

        return {
            "active_rule_id": self.active_rule_id,
            "active_rule_name": (scene_name if profile is not None else None),
            "active_macro": (self._shot or {}).get("macro_id"),
            "override_rule_id": rule["id"] if (rule and pinned) else None,
            "override_macro_id": None,
            "director": director,
            "fired": fired,
            "dry_run": dry_run,
            "matching": self._matching_preview(cfg.get("rules") or [], activity),
            "director_mode": director_mode,
            "pinned": pinned,
            "reason": reason,
            "beat": beat,
            "pace": pace,
        }

    def _matching_preview(self, rules: list[dict[str, Any]],
                          activity: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        states = self._match_states(activity)
        out = []
        for r in sorted([r for r in rules if r.get("enabled", True)],
                        key=lambda r: -int(r.get("priority", 0))):
            if not self._match(r, states):
                continue
            who = (r.get("profile") or {}).get("who") or []
            out.append({
                "id": r["id"], "name": r.get("name"),
                "priority": int(r.get("priority", 0)),
                "is_active": r["id"] == self.active_rule_id,
                "preview": f"대상 {len(who)}개" if who else "전체",
            })
        return out

    # ── Firing / dispatch ─────────────────────────────────────────

    @staticmethod
    def _macro_index(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {m["id"]: m for m in (cfg.get("macros") or []) if m.get("id")}

    def _fire_macro(self, rule: dict[str, Any] | None, macro: dict[str, Any],
                    dry_run: bool, now: float, cause: str) -> dict[str, Any]:
        token = str(macro.get("token") or "")
        cam = macro.get("camera")
        cam_str = f" (cam{cam})" if cam not in (None, "") else ""
        scene = (rule or {}).get("name") or "기본 장면"
        evt = {
            "ts": now,
            "wall_ts": time.time(),
            "rule_id": (rule or {}).get("id"),
            "rule_name": scene,
            "type": "shot",
            "detail": f"shot → {macro.get('name') or token}{cam_str} · {scene}",
            "dry_run": dry_run,
            "cause": cause,
            "dispatched": False,
            "dispatch_error": None,
            "macro_id": macro.get("id"),
            "macro_name": macro.get("name"),
            "camera": cam,
            "subjects": macro.get("subjects") or [],
            "token": token,
        }
        if not dry_run:
            try:
                evt["dispatched"] = self._dispatch(token) or False
            except Exception as e:
                evt["dispatch_error"] = str(e)
        self._action_log.append(evt)
        return evt

    def _dispatch(self, token: str) -> bool:
        """POST the shot's token to the ASS HTTP server. True means handed off
        (it is fired on a daemon thread, so this is not a delivery receipt)."""
        ass = (self.config_store.snapshot()
               .get("connections", {})
               .get("ass_http", {}))
        url = (ass.get("url") or "").strip()
        if not url:
            return False
        method = (ass.get("method") or "POST").upper()
        body = token.encode("utf-8") if method == "POST" else None
        threading.Thread(
            target=self._do_http,
            args=(method, url, body),
            daemon=True,
            name="http-dispatch",
        ).start()
        return True

    @staticmethod
    def _do_http(method: str, url: str, body: bytes | None) -> None:
        try:
            req = urllib.request.Request(url, data=body, method=method)
            if body is not None:
                req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=3) as resp:
                resp.read(0)  # drain quickly; we don't care about the body
        except (urllib.error.URLError, OSError, ValueError) as e:
            logger.warning("shot dispatch failed: %s %s — %s", method, url, e)
