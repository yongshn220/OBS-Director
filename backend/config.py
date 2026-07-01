from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any


def new_macro_id() -> str:
    return "mac_" + uuid.uuid4().hex[:8]


def new_transition_id() -> str:
    return "trn_" + uuid.uuid4().hex[:8]

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
PROJECTS_DIR = CONFIG_PATH.parent / "projects"

# Keys that live inside a project file (per-project setup the user switches
# between for different services / events).
PROJECT_KEYS = ("channels", "groups", "macros", "transitions", "rules")
# Keys that stay in the global config.json — hardware/runtime state that
# applies regardless of which project is active.
GLOBAL_KEYS = ("audio", "connections", "runtime", "current_project")

DEFAULT_PROJECT_NAME = "default"
PROJECT_NAME_RE = re.compile(r"^[\w\s가-힣ㄱ-ㅎㅏ-ㅣ\-]{1,40}$", flags=re.UNICODE)

DEFAULT_CHANNELS = 32

DEFAULT_GROUPS: dict[str, dict[str, Any]] = {
    "singers":     {"attack_ms": 200, "release_ms": 1500, "color": "#00ff88"},
    "instruments": {"attack_ms": 150, "release_ms": 800,  "color": "#4488ff"},
    "pastor":      {"attack_ms": 150, "release_ms": 1200, "color": "#ffd700"},
}


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
    return [
        {"id": i + 1, "name": "", "groups": [], "threshold_db": -45.0}
        for i in range(DEFAULT_CHANNELS)
    ]


def _empty_project() -> dict[str, Any]:
    """A fresh project: default channels, seed groups, no rules/macros/transitions."""
    return {
        "channels": _default_channels(),
        "groups": dict(DEFAULT_GROUPS),
        "macros": [],
        "transitions": [],
        "rules": [],
    }


def _normalize_macro(m: dict[str, Any]) -> dict[str, Any]:
    """Coerce a macro entry. camera is kept as-is (str/int/None) so the engine
    can compare equality; token is the payload POSTed to ASS to fire it; group
    (optional) reuses a channel group name so a transition can avoid two
    same-subject shots in a row."""
    cam = m.get("camera")
    if isinstance(cam, str):
        cam = cam.strip() or None
    grp = m.get("group")
    grp = grp.strip() if isinstance(grp, str) and grp.strip() else None
    return {
        "id": str(m.get("id") or new_macro_id()),
        "name": str(m.get("name") or ""),
        "token": str(m.get("token") or "").strip(),
        "camera": cam,
        "group": grp,
    }


def _to_float(v: Any, default: float) -> float:
    """float() that tolerates None / '' / junk (dict.get's default only kicks
    in for ABSENT keys, not present-but-null ones, which appear in hand-edited
    or exported project files and would otherwise crash normalization)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _normalize_transition(t: dict[str, Any], valid_macro_ids: set[str]) -> dict[str, Any]:
    """Coerce a transition. The deck is filtered to existing macro ids so a
    deleted macro never lingers as a dangling reference."""
    deck = [str(mid) for mid in (t.get("deck") or []) if str(mid) in valid_macro_ids]
    # camera_weights: how many times each camera appears per rotation round
    # (string camera value -> int >= 1). Absent cameras default to 1.
    weights: dict[str, int] = {}
    raw_w = t.get("camera_weights")
    if isinstance(raw_w, dict):
        for k, v in raw_w.items():
            try:
                iv = int(v)
            except (TypeError, ValueError):
                continue
            if iv >= 1:
                weights[str(k)] = iv
    return {
        "id": str(t.get("id") or new_transition_id()),
        "name": str(t.get("name") or ""),
        "deck": deck,
        "interval_s": _to_float(t.get("interval_s"), 8.0),
        "camera_alternate": bool(t.get("camera_alternate", True)),
        "camera_weights": weights,
        "group_alternate": bool(t.get("group_alternate", False)),
    }


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
            "refire_s": 3.0,
            # Operator's manual transition pin (null = rules choose). Always
            # reset to null on startup so an auto-launched service never boots
            # stuck on a hand-picked transition.
            "override_transition_id": None,
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
    legacy single-group channels to the groups-list schema, and keep macro /
    transition / rule references internally consistent (no dangling ids)."""
    project.setdefault("channels", _default_channels())
    project.setdefault("groups", dict(DEFAULT_GROUPS))
    project.setdefault("macros", [])
    project.setdefault("transitions", [])
    project.setdefault("rules", [])

    # Top-up channels list to DEFAULT_CHANNELS so the UI grid is always full.
    # Drop malformed (non-dict / id-less) entries rather than crashing; the
    # merge loop rebuilds the full 1..N grid from defaults anyway.
    existing = {
        c["id"]: c for c in (project.get("channels") or [])
        if isinstance(c, dict) and "id" in c
    }
    merged: list[dict[str, Any]] = []
    for c in _default_channels():
        merged.append(existing.get(c["id"], c))

    # Migrate legacy ch.group: str|None  →  ch.groups: list[str]
    for ch in merged:
        if "groups" not in ch:
            legacy = ch.pop("group", None)
            ch["groups"] = [legacy] if legacy else []
        else:
            ch.pop("group", None)
            seen: set[str] = set()
            ch["groups"] = [
                g for g in (ch.get("groups") or [])
                if g and not (g in seen or seen.add(g))
            ]
    project["channels"] = merged

    # Macros (dedupe ids; keep first wins). The macro `group` is a FREE-FORM
    # visual-subject tag (e.g. "Singer1", "PIANO") used only for the
    # "그룹 교대" anti-repeat option — intentionally independent of the
    # channel/audio groups, which are coarser, so it is NOT pruned against them.
    macros: list[dict[str, Any]] = []
    macro_ids: set[str] = set()
    for m in (project.get("macros") or []):
        nm = _normalize_macro(m)
        if nm["id"] in macro_ids:
            nm["id"] = new_macro_id()
        macro_ids.add(nm["id"])
        macros.append(nm)
    project["macros"] = macros

    # Transitions (deck filtered to existing macros; dedupe ids)
    transitions: list[dict[str, Any]] = []
    transition_ids: set[str] = set()
    for t in (project.get("transitions") or []):
        nt = _normalize_transition(t, macro_ids)
        if nt["id"] in transition_ids:
            nt["id"] = new_transition_id()
        transition_ids.add(nt["id"])
        transitions.append(nt)
    project["transitions"] = transitions

    # Rules: drop transition actions that reference a deleted transition so
    # the engine never dispatches to a missing target.
    for rule in (project.get("rules") or []):
        kept = []
        for a in (rule.get("actions") or []):
            # Prune only genuinely DANGLING transition refs (non-empty id that
            # points at a deleted transition). An empty transition_id is an
            # intentional "not yet chosen" placeholder — keep it so a freshly
            # added transition action survives the persist round-trip until the
            # user picks a target. (The engine no-ops an empty id.)
            tid = a.get("transition_id")
            if a.get("type") == "transition" and tid and tid not in transition_ids:
                continue
            kept.append(a)
        rule["actions"] = kept

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
            for k in PROJECT_KEYS:
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

        # Normalize FIRST, then persist — so a freshly created / migrated
        # project file is written in its complete shape (macros, transitions,
        # migrated channels) rather than the raw pre-normalized input.
        project_data = _normalize_project(project_data)
        if needs_write:
            self._write_project_file(current, project_data)

        # Fill global defaults for anything the file omitted.
        defaults_g = _default_globals()
        for k, v in defaults_g.items():
            globals_raw.setdefault(k, v)
        globals_raw["current_project"] = current
        # Clear any manual transition pin on startup — a hand override should
        # never survive a restart (the app auto-launches at login).
        if isinstance(globals_raw.get("runtime"), dict):
            globals_raw["runtime"]["override_transition_id"] = None

        # Persist globals stripped of any legacy project keys.
        self._write_globals_file(globals_raw)

        return {**globals_raw, **project_data}

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
        clean = {k: v for k, v in data.items() if k not in PROJECT_KEYS}
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
                    1 for c in channels if (c.get("groups") or c.get("group"))
                ),
                "group_count": len(data.get("groups") or {}),
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
            # Load the target project into live state.
            with target.open("r", encoding="utf-8") as f:
                proj = _normalize_project(json.load(f))
            new_data = {
                **{k: v for k, v in self._data.items() if k in GLOBAL_KEYS},
                **proj,
                "current_project": name,
            }
            self._data = new_data
            self._write_globals_file(new_data)
            return json.loads(json.dumps(new_data))
