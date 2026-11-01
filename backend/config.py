from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any


def new_macro_id() -> str:
    return "mac_" + uuid.uuid4().hex[:8]


CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
PROJECTS_DIR = CONFIG_PATH.parent / "projects"

# Keys that live inside a project file (per-project setup the user switches
# between for different services / events).
PROJECT_KEYS = ("channels", "groups", "roles", "cameras", "macros", "rules")
# Same, plus keys that USED to live in a project file. Only used when sniffing
# a legacy top-level config.json so an old `transitions` array still reaches
# _normalize_project (which folds it into rule profiles) instead of being
# stranded in globals.
LEGACY_PROJECT_KEYS = PROJECT_KEYS + ("transitions",)
# Keys that stay in the global config.json — hardware/runtime state that
# applies regardless of which project is active.
GLOBAL_KEYS = ("audio", "connections", "runtime", "current_project")

DEFAULT_PROJECT_NAME = "default"
PROJECT_NAME_RE = re.compile(r"^[\w\s가-힣ㄱ-ㅎㅏ-ㅣ\-]{1,40}$", flags=re.UNICODE)

DEFAULT_CHANNELS = 32

# Groups = coarse categories (rule matching), with attack/release timing.
DEFAULT_GROUPS: dict[str, dict[str, Any]] = {
    "singers":     {"attack_ms": 200, "release_ms": 1500, "color": "#00ff88"},
    "instruments": {"attack_ms": 150, "release_ms": 800,  "color": "#4488ff"},
    "pastor":      {"attack_ms": 150, "release_ms": 1200, "color": "#ffd700"},
}

# Roles = fine subject identities (dynamic-planning shot targets). Each role
# belongs to ONE group and inherits that group's timing. Shape:
#   {role_name: {"group": <group_name|None>, "color": "#rrggbb"}}
DEFAULT_ROLES: dict[str, dict[str, Any]] = {}

# ── Shot subjects ───────────────────────────────────────────────────────
# Every shot names WHO it is of, as a single prefixed key:
#   "role:Piano"        — a specific person/instrument (fine)
#   "team:instruments"  — a whole group (coarse)
#   "WIDE"              — no single subject (stage wide, establishing, cutaway)
# This replaces the old macro `sources` (an OR-set of audio-group names) +
# `group` (a free-form visual-subject tag), which duplicated each other and
# had no way to express a wide shot's real trigger. WIDE is not "always on":
# the planner surfaces it when several subjects are live at once, when nothing
# is live (a breather), or when the shot grammar is due for an establishing
# beat — none of which an OR-set could say.
SUBJECT_WIDE = "WIDE"
SHOT_SIZES = ("wide", "mid", "tight")


def role_subject(name: str) -> str:
    return f"role:{name}"


def team_subject(name: str) -> str:
    return f"team:{name}"


def split_subject(subject: str | None) -> tuple[str, str]:
    """('role'|'team'|'wide'|'none', bare_name). The planner uses the kind to
    decide which activity table (roles vs groups) to look the subject up in."""
    if not subject:
        return ("none", "")
    if subject == SUBJECT_WIDE:
        return ("wide", "")
    kind, _, name = subject.partition(":")
    if kind in ("role", "team") and name:
        return (kind, name)
    return ("none", "")


class ProjectNameError(ValueError):
    """Raised when a project name fails validation."""


def _validate_project_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ProjectNameError("프로젝트 이름이 비어 있습니다")
    if not PROJECT_NAME_RE.match(name):
        raise ProjectNameError(
            "프로젝트 이름은 한글/영문/숫자/공백/-/_ 만 허용됩니다 (최대 40자)"
        )
    return name


def _default_channels() -> list[dict[str, Any]]:
    # A channel picks ONE role (fine identity) and belongs to ONE group (coarse
    # category). group is normally derived from the role, but may be set alone
    # for a role-less channel. Both default to None (unconfigured).
    # `beat_source` marks a channel the tempo tracker listens to — percussive
    # inputs give a far cleaner onset than the full mix.
    return [
        {"id": i + 1, "name": "", "role": None, "group": None,
         "threshold_db": -45.0, "beat_source": False}
        for i in range(DEFAULT_CHANNELS)
    ]


# Role names that look percussive enough to seed `beat_source` on first load.
# Only ever used to pre-fill the flag; the operator's choice always wins after.
_DRUMMY = ("drum", "퍼커션", "드럼", "kick", "snare", "perc")


def _empty_project() -> dict[str, Any]:
    """A fresh project: default channels, seed groups, no roles/rules/shots."""
    return {
        "channels": _default_channels(),
        "groups": dict(DEFAULT_GROUPS),
        "roles": dict(DEFAULT_ROLES),
        "cameras": [],
        "macros": [],
        "rules": [],
    }


def _normalize_cameras(project: dict[str, Any]) -> list[str]:
    """The physical cameras available, as an explicit ordered list.

    Deriving this from whatever the shots happened to mention was a mistake:
    a camera could not exist until some shot already used it, so the assign
    grid had no column to fill in and there was no way to set a rig up before
    building shots. Cameras are real hardware with a stable identity, so the
    project states them outright. Any camera a shot names is folded in, which
    both migrates older projects and keeps a hand-edited file consistent.
    """
    cams: list[str] = []
    for c in (project.get("cameras") or []):
        c = str(c).strip()
        if c and c not in cams:
            cams.append(c)
    for m in (project.get("macros") or []):
        c = m.get("camera")
        c = str(c).strip() if c is not None else ""
        if c and c not in cams:
            cams.append(c)
    # Numeric names sort naturally; anything else trails in insertion order.
    return sorted(cams, key=lambda c: (0, int(c), "") if c.isdigit() else (1, 0, c))


def _migrate_macro_subject(m: dict[str, Any], roles: dict[str, Any],
                           groups: dict[str, Any]) -> str | None:
    """Derive a `subject` from the legacy `sources` list (one-time migration).

    Legacy shape was an OR-set of role/group names, so:
      - exactly one source  → that role (or team, if it names a group)
      - several sources     → their common team if they share one, else WIDE
      - no sources          → WIDE. Under the old engine an empty `sources`
        meant "never selectable", which is exactly how the stage/room wide
        shots ended up configured — they were the shots the operator could not
        express. WIDE is what they were always meant to be.
    """
    srcs = [str(s).strip() for s in (m.get("sources") or []) if str(s).strip()]
    if not srcs:
        return SUBJECT_WIDE
    if len(srcs) == 1:
        s = srcs[0]
        if s in roles:
            return role_subject(s)
        if s in groups:
            return team_subject(s)
        return role_subject(s)  # stale name — keep it visible rather than lose it
    owning = {roles[s]["group"] for s in srcs if s in roles and roles[s].get("group")}
    if len(owning) == 1:
        return team_subject(owning.pop())
    return SUBJECT_WIDE


def _normalize_macro(m: dict[str, Any], roles: dict[str, Any],
                     groups: dict[str, Any]) -> dict[str, Any]:
    """Coerce a shot entry.

    A shot is defined ONCE — name, token, camera, size — and then assigned to
    whoever it covers. `subjects` is that assignment: a list, because one shot
    can legitimately cover more than one person (a two-shot of the front pair)
    and because assignment is edited from the subject's side, not the shot's.
    An empty list means the shot exists but is not assigned to anyone yet: it
    stays available for a manual take and for explicit scene shot lists, and
    the planner simply never auto-selects it.

    camera is kept as-is (str/int/None) so the planner can compare equality;
    token is the payload POSTed to ASS to fire it; size is the framing, which
    nudges how long the shot holds and drives the establishing cadence.

    Subjects are NOT pruned against the live role/group lists — a rename would
    otherwise silently delete the link. A dangling subject never becomes
    eligible, and the assign grid shows it in its own row so it can be
    re-pointed rather than quietly lost.
    """
    cam = m.get("camera")
    if isinstance(cam, str):
        cam = cam.strip() or None

    if "subjects" in m:
        raw = m.get("subjects") or []
    elif "subject" in m:                       # single-subject era
        raw = [m["subject"]] if m.get("subject") else []
    elif "sources" in m or "group" in m:       # pre-subject era
        migrated = _migrate_macro_subject(m, roles, groups)
        raw = [migrated] if migrated else []
    else:
        raw = []
    subjects: list[str] = []
    for s in raw:
        s = str(s).strip() if s else ""
        if s and s not in subjects and split_subject(s)[0] != "none":
            subjects.append(s)

    size = str(m.get("size") or "").strip().lower()
    if size not in SHOT_SIZES:
        size = "wide" if SUBJECT_WIDE in subjects else "tight"

    return {
        "id": str(m.get("id") or new_macro_id()),
        "name": str(m.get("name") or ""),
        "token": str(m.get("token") or "").strip(),
        "camera": cam,
        "subjects": subjects,
        "size": size,
    }


def _to_float(v: Any, default: float) -> float:
    """float() that tolerates None / '' / junk (dict.get's default only kicks
    in for ABSENT keys, not present-but-null ones, which appear in hand-edited
    or exported project files and would otherwise crash normalization)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# Default minimum time a scene keeps the floor once it takes over. Only a
# default now — each scene carries its own `hold_s`.
SCENE_HOLD_S = 3.0
SCENE_HOLD_MAX_S = 60.0

# A scene says WHEN it applies (the rule's conditions) and WHO it may cover.
# It says nothing about how to shoot — that is one algorithm, the same in every
# scene, so there is no per-scene pacing to get out of sync between services.
DEFAULT_PROFILE: dict[str, Any] = {
    # Who this scene may cut to. Empty = every assigned subject, which is what
    # lets a newly-active singer get covered without being listed first.
    "who": [],
    # Which cameras this scene may use at all. Empty = every camera. This is a
    # property of the scene, not of each subject: a segment is shot on a set of
    # cameras and everyone in it is covered from those, so stating it per
    # subject would just be the same list repeated with more ways to get it
    # wrong. Named by camera rather than by shot id so a re-rig cannot break it.
    "cameras": [],
    # Once this scene takes over, it keeps the floor for at least this long,
    # even against a higher-priority rule. Per scene because the right answer
    # differs: a sermon should not be yanked away by a stray note, while a
    # worship scene wants to give way promptly.
    "hold_s": SCENE_HOLD_S,
}

# The one pacing control, global rather than per-scene: how many beats a shot
# holds. 4/8/16 = 1/2/4 bars in common time. The seconds are the fallback used
# when the beat tracker has no lock (speech, or music with no drums).
PACES = ("fast", "normal", "slow")
PACE_BEATS = {"fast": 4, "normal": 8, "slow": 16}
PACE_SECONDS = {"fast": 4.0, "normal": 7.0, "slow": 12.0}
DEFAULT_PACE = "normal"



def default_profile() -> dict[str, Any]:
    """A fresh copy of DEFAULT_PROFILE — its list/dict members must not be
    shared between scenes."""
    return {k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v)
            for k, v in DEFAULT_PROFILE.items()}


def _normalize_profile(p: dict[str, Any] | None, macros: list[dict[str, Any]]) -> dict[str, Any]:
    """Coerce a scene profile down to its one field: who it may cover.

    Earlier shapes named SHOTS (a deck, or a pinned single). Shots are one step
    too low: which angle to use is the algorithm's job, and a scene that lists
    angles goes stale the moment a camera is re-rigged. Any recorded shot list
    is therefore folded up into the subjects those shots cover.
    """
    p = p if isinstance(p, dict) else {}
    raw = p.get("who")
    if raw is None:
        # Fold a legacy shot list (incl. a single pinned shot) up to subjects.
        by_id = {m["id"]: m for m in macros}
        legacy = p.get("shots")
        if legacy is None and p.get("forced_shot"):
            legacy = [p["forced_shot"]]
        raw = [s for mid in (legacy or [])
               for s in (by_id.get(str(mid), {}).get("subjects") or [])]
    # A short-lived shape keyed cameras per subject; fold it back to one list
    # of subjects plus the union of the cameras it named.
    inherited: list[str] = []
    if isinstance(raw, dict):
        for cams in raw.values():
            for c in (cams or []):
                c = str(c).strip()
                if c and c not in inherited:
                    inherited.append(c)
        raw = list(raw.keys())
    if not isinstance(raw, list):
        raw = []

    who: list[str] = []
    for s in raw:
        s = str(s).strip() if s else ""
        if s and s not in who and split_subject(s)[0] != "none":
            who.append(s)

    cameras: list[str] = []
    for c in (p.get("cameras") if p.get("cameras") is not None else inherited) or []:
        c = str(c).strip()
        if c and c not in cameras:
            cameras.append(c)
    hold = _to_float(p.get("hold_s"), SCENE_HOLD_S)
    hold = max(0.0, min(SCENE_HOLD_MAX_S, hold))
    return {"who": who, "cameras": cameras, "hold_s": hold}


def _default_globals() -> dict[str, Any]:
    return {
        "audio": {
            "device_name": "X32",
            "device_index": None,
            "channels": DEFAULT_CHANNELS,
            "samplerate": 48000,
            "blocksize": 2048,
            "demo_mode": False,
        },
        "runtime": {
            "auto": True,
            "dry_run": True,
            # Director mode: "rules" (a matching rule frames the scene, the
            # planner fills it) or "dynamic" (skip rules entirely and shoot the
            # default profile against whatever is live). Persists across
            # restarts — it's a deliberate operating mode, not a transient pin.
            "director_mode": "rules",
            # The one pacing control (see PACES).
            "pace": DEFAULT_PACE,
            # The scene used when no rule matches, and in "dynamic" mode.
            "profile": default_profile(),
            # Operator's manual pins (null = rules choose). override_macro_id
            # holds one shot; override_rule_id forces one scene. Both reset to
            # null on startup so an auto-launched service never boots stuck on
            # a hand-picked shot/scene.
            "override_rule_id": None,
            "override_macro_id": None,
        },
        "connections": {
            "ass_http": {"url": "http://localhost:7654/trigger", "method": "POST"},
        },
        "current_project": DEFAULT_PROJECT_NAME,
    }


def _default_config() -> dict[str, Any]:
    """Full live shape (globals merged with default project) — used by tests
    and as a fallback when nothing on disk exists."""
    return {**_default_globals(), **_empty_project()}


def _normalize_project(project: dict[str, Any]) -> dict[str, Any]:
    """Ensure a project dict has all required keys with sane shapes, migrate
    legacy channels to the role/group schema, and keep role / macro / transition
    / rule references internally consistent (no dangling ids).

    Model: channel → role → group. A channel picks one role (fine subject
    identity) and belongs to one group (coarse category); the group is derived
    from the role when a role is set. Roles each belong to one group and inherit
    its attack/release timing."""
    project.setdefault("channels", _default_channels())
    project.setdefault("groups", dict(DEFAULT_GROUPS))
    project.setdefault("roles", dict(DEFAULT_ROLES))
    project.setdefault("cameras", [])
    project.setdefault("macros", [])
    project.setdefault("rules", [])

    groups = project.get("groups")
    if not isinstance(groups, dict):
        groups = dict(DEFAULT_GROUPS)
    project["groups"] = groups

    # Roles: {name: {group: <existing group|None>, color}}. A role's group is
    # pruned to an existing group (dangling → None) so activity/UI never point
    # at a deleted group; the role itself survives for re-assignment.
    roles: dict[str, dict[str, Any]] = {}
    raw_roles = project.get("roles")
    if isinstance(raw_roles, dict):
        for rname, r in raw_roles.items():
            rname = str(rname).strip()
            if not rname:
                continue
            r = r if isinstance(r, dict) else {}
            g = r.get("group")
            roles[rname] = {
                "group": g if g in groups else None,
                "color": str(r.get("color") or "#888888"),
            }
    project["roles"] = roles

    # Top-up channels to DEFAULT_CHANNELS so the UI grid is always full. Drop
    # malformed (non-dict / id-less) entries; the merge rebuilds the 1..N grid.
    existing = {
        c["id"]: c for c in (project.get("channels") or [])
        if isinstance(c, dict) and "id" in c
    }
    merged: list[dict[str, Any]] = []
    for c in _default_channels():
        merged.append(existing.get(c["id"], c))

    # Normalize each channel to {id, name, role, group, threshold_db}:
    #   - role pruned to an existing role (else None)
    #   - group derived from the role when set; else the channel's own group, or
    #     migrated from a legacy `groups:[..]` list (first) / `group` string.
    #     Pruned to an existing group.
    for ch in merged:
        role = ch.get("role")
        role = role if role in roles else None
        if role is not None:
            grp = roles[role]["group"]
        else:
            grp = ch.get("group")
            if grp is None:
                legacy_list = ch.get("groups") or []
                grp = legacy_list[0] if legacy_list else None
            grp = grp if grp in groups else None
        ch.pop("groups", None)  # drop the obsolete multi-group list
        ch["name"] = str(ch.get("name") or "")
        ch["role"] = role
        ch["group"] = grp
        ch["threshold_db"] = _to_float(ch.get("threshold_db"), -45.0)
        # Seed the tempo source once, from role names that read as percussion,
        # so an existing rig gets a beat without hunting for the setting. Only
        # ever a seed: once the key exists the operator's choice is kept.
        if "beat_source" in ch:
            ch["beat_source"] = bool(ch["beat_source"])
        else:
            ch["beat_source"] = bool(role and any(d in role.lower() for d in _DRUMMY))
    project["channels"] = merged

    # Shots (dedupe ids; first wins). Subjects are resolved against roles /
    # groups only for the one-time legacy migration — see _normalize_macro.
    macros: list[dict[str, Any]] = []
    macro_ids: set[str] = set()
    for m in (project.get("macros") or []):
        nm = _normalize_macro(m, roles, groups)
        if nm["id"] in macro_ids:
            nm["id"] = new_macro_id()
        macro_ids.add(nm["id"])
        macros.append(nm)
    project["macros"] = macros
    project["cameras"] = _normalize_cameras(project)

    # Rules carry their scene profile inline. Two older shapes get folded up
    # here: a shared `transition` referenced by id (its deck → the subjects
    # that deck covered), and an inline shot list (same fold).
    legacy_transitions = {
        str(t.get("id")): t for t in (project.get("transitions") or [])
        if isinstance(t, dict) and t.get("id")
    }
    for rule in (project.get("rules") or []):
        if not isinstance(rule, dict):
            continue
        # A scene is referred to by name everywhere in the UI (pins, on-air
        # readout, the also-matching queue), so it must always have one.
        rule["name"] = str(rule.get("name") or "").strip() or "이름 없는 장면"
        profile = rule.get("profile")
        if not isinstance(profile, dict):
            tid = next(
                (a.get("transition_id") for a in (rule.get("actions") or [])
                 if isinstance(a, dict) and a.get("type") == "transition" and a.get("transition_id")),
                None,
            )
            t = legacy_transitions.get(str(tid)) if tid else None
            profile = {"shots": list(t.get("deck") or [])} if t else {}
        rule["profile"] = _normalize_profile(profile, macros)
        # A scene no longer dispatches or paces; it frames. The raw-HTTP escape
        # hatch `actions` held is equivalent to a shot whose token is that body.
        rule.pop("actions", None)
        rule.pop("cooldown_s", None)   # now the fixed SCENE_HOLD_S
    project.pop("transitions", None)

    # The default scene lives in globals but its `who` is checked against the
    # same subject space, so it is normalized here. Absent when normalizing a
    # bare project file — _load_or_init re-runs this after merging globals.
    rt = project.get("runtime")
    if isinstance(rt, dict):
        rt["profile"] = _normalize_profile(rt.get("profile"), macros)
        pace = str(rt.get("pace") or "").strip().lower()
        rt["pace"] = pace if pace in PACES else DEFAULT_PACE
        rt.pop("dynamic", None)

    return project


class ConfigStore:
    """Thread-safe config store split across two files:

      - config.json       — global state (audio device, connections, runtime
                            toggles) + a `current_project` pointer.
      - projects/<n>.json — per-project setup (channels, groups, rules) that
                            the user switches between for different services.

    Reads/writes through this class expose a single flat dict to callers so
    existing code paths (`config.channels`, etc.) keep working transparently;
    the file-level split only matters during load/save and project switches.
    """

    def __init__(self, path: Path = CONFIG_PATH, projects_dir: Path = PROJECTS_DIR):
        self.path = path
        self.projects_dir = projects_dir
        self._lock = threading.RLock()
        self._data: dict[str, Any] = self._load_or_init()

    # ── Lifecycle ──────────────────────────────────────────────────

    def _load_or_init(self) -> dict[str, Any]:
        self.projects_dir.mkdir(parents=True, exist_ok=True)

        # Read globals (and detect a legacy config.json that still has
        # project keys at the top level — we'll migrate it once).
        globals_raw: dict[str, Any] = {}
        legacy_project: dict[str, Any] = {}
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as f:
                    globals_raw = json.load(f)
            except (json.JSONDecodeError, OSError):
                globals_raw = {}
            for k in LEGACY_PROJECT_KEYS:
                if k in globals_raw:
                    legacy_project[k] = globals_raw.pop(k)

        current = globals_raw.get("current_project") or DEFAULT_PROJECT_NAME
        try:
            current = _validate_project_name(current)
        except ProjectNameError:
            current = DEFAULT_PROJECT_NAME

        # Resolve project data: existing file > legacy migration > empty.
        proj_path = self._project_path(current)
        needs_write = False
        if proj_path.exists():
            try:
                with proj_path.open("r", encoding="utf-8") as f:
                    project_data = json.load(f)
            except (json.JSONDecodeError, OSError):
                project_data = _empty_project()
        elif legacy_project:
            project_data = legacy_project
            needs_write = True
        else:
            project_data = _empty_project()
            needs_write = True

        # Fill global defaults for anything the file omitted.
        defaults_g = _default_globals()
        for k, v in defaults_g.items():
            globals_raw.setdefault(k, v)
        globals_raw["current_project"] = current
        # Clear any manual pins on startup — a hand override should never
        # survive a restart (the app auto-launches at login).
        if isinstance(globals_raw.get("runtime"), dict):
            rt = globals_raw["runtime"]
            rt.pop("override_transition_id", None)   # renamed → override_rule_id
            rt.pop("refire_s", None)                 # http_request actions are gone
            rt["override_rule_id"] = None
            rt["override_macro_id"] = None
            # Backfill planning keys on pre-existing configs (director mode DOES
            # persist across restart, unlike the pins above). A legacy
            # `dynamic: {interval_s}` becomes the default profile's target hold.
            rt["director_mode"] = "dynamic" if rt.get("director_mode") == "dynamic" else "rules"
            rt.pop("dynamic", None)     # pacing is global now, not per-mode
            if not isinstance(rt.get("profile"), dict):
                rt["profile"] = {}      # shaped by the _normalize_project pass below

        # Normalize the MERGED shape so the default profile (globals) is checked
        # against the shot list (project) in one pass, then persist — a freshly
        # created or migrated file is written complete rather than raw.
        merged = _normalize_project({**globals_raw, **project_data})
        # Always write back, not just when `needs_write`: normalization also
        # performs the one-time migration (shot subjects, transitions → rule
        # profiles), and leaving that only in memory would re-run it on every
        # boot against a file that never catches up.
        self._write_project_file(current, merged)
        self._write_globals_file(merged)
        return merged

    # ── Persistence helpers ────────────────────────────────────────

    def _project_path(self, name: str) -> Path:
        return self.projects_dir / f"{name}.json"

    @staticmethod
    def _atomic_write(target: Path, data: dict[str, Any]) -> None:
        tmp = target.with_suffix(target.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp.replace(target)

    def _write_globals_file(self, data: dict[str, Any]) -> None:
        clean = {k: v for k, v in data.items() if k not in LEGACY_PROJECT_KEYS}
        self._atomic_write(self.path, clean)

    def _write_project_file(self, name: str, data: dict[str, Any]) -> None:
        clean = {k: data[k] for k in PROJECT_KEYS if k in data}
        self._atomic_write(self._project_path(name), clean)

    # ── Public API (unchanged shape) ───────────────────────────────

    def get(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data))

    def update(self, mutator) -> dict[str, Any]:
        """Apply mutator(data) -> data, persist to both files, return snapshot."""
        with self._lock:
            new_data = mutator(json.loads(json.dumps(self._data)))
            new_data = _normalize_project(new_data)
            current = new_data.get("current_project") or DEFAULT_PROJECT_NAME
            new_data["current_project"] = current
            self._data = new_data
            self._write_globals_file(new_data)
            self._write_project_file(current, new_data)
            return json.loads(json.dumps(new_data))

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._data

    # ── Project management ────────────────────────────────────────

    def list_projects(self) -> list[dict[str, Any]]:
        """List saved projects with a brief summary (counts)."""
        out: list[dict[str, Any]] = []
        for p in sorted(self.projects_dir.glob("*.json")):
            name = p.stem
            if p.suffix == ".json.tmp":
                continue
            try:
                with p.open("r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue
            channels = data.get("channels") or []
            out.append({
                "name": name,
                "channel_count": sum(
                    1 for c in channels if (c.get("group") or c.get("role"))
                ),
                "group_count": len(data.get("groups") or {}),
                "role_count": len(data.get("roles") or {}),
                "rule_count": len(data.get("rules") or []),
            })
        return out

    def create_project(self, name: str, copy_from: str | None = None) -> str:
        name = _validate_project_name(name)
        with self._lock:
            target = self._project_path(name)
            if target.exists():
                raise ProjectNameError(f"이미 존재하는 프로젝트입니다: {name}")
            if copy_from:
                src = self._project_path(_validate_project_name(copy_from))
                if not src.exists():
                    raise FileNotFoundError(f"원본 프로젝트가 없습니다: {copy_from}")
                with src.open("r", encoding="utf-8") as f:
                    data = json.load(f)
            else:
                data = _empty_project()
            data = _normalize_project(data)
            self._write_project_file(name, data)
            return name

    def delete_project(self, name: str) -> None:
        name = _validate_project_name(name)
        with self._lock:
            if self._data.get("current_project") == name:
                raise ProjectNameError("현재 활성 프로젝트는 삭제할 수 없습니다")
            projects = [p["name"] for p in self.list_projects()]
            if name not in projects:
                raise FileNotFoundError(f"프로젝트가 없습니다: {name}")
            if len(projects) <= 1:
                raise ProjectNameError("마지막 프로젝트는 삭제할 수 없습니다")
            self._project_path(name).unlink()

    def rename_project(self, old: str, new: str) -> str:
        old = _validate_project_name(old)
        new = _validate_project_name(new)
        if old == new:
            return new
        with self._lock:
            src = self._project_path(old)
            dst = self._project_path(new)
            if not src.exists():
                raise FileNotFoundError(f"프로젝트가 없습니다: {old}")
            if dst.exists():
                raise ProjectNameError(f"이미 존재하는 프로젝트입니다: {new}")
            src.rename(dst)
            if self._data.get("current_project") == old:
                self._data["current_project"] = new
                self._write_globals_file(self._data)
            return new

    def activate_project(self, name: str) -> dict[str, Any]:
        name = _validate_project_name(name)
        with self._lock:
            target = self._project_path(name)
            if not target.exists():
                raise FileNotFoundError(f"프로젝트가 없습니다: {name}")
            # Flush in-memory project data to its file just to be safe.
            current = self._data.get("current_project") or DEFAULT_PROJECT_NAME
            self._write_project_file(current, self._data)
            # Load the target project into live state. Normalize the MERGED
            # shape so the default profile is re-checked against the incoming
            # project's shots, so a `who` naming a subject the new project does
            # not cover is dropped rather than left dangling.
            with target.open("r", encoding="utf-8") as f:
                proj = json.load(f)
            new_data = _normalize_project({
                **{k: v for k, v in self._data.items() if k in GLOBAL_KEYS},
                **proj,
                "current_project": name,
            })
            self._data = new_data
            self._write_globals_file(new_data)
            return json.loads(json.dumps(new_data))
