from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
PROJECTS_DIR = CONFIG_PATH.parent / "projects"

# Keys that live inside a project file (per-project setup the user switches
# between for different services / events).
PROJECT_KEYS = ("channels", "groups", "rules")
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
    """A fresh project: default channels, seed groups, no rules."""
    return {
        "channels": _default_channels(),
        "groups": dict(DEFAULT_GROUPS),
        "rules": [],
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
    """Ensure a project dict has all required keys with sane shapes, and
    migrate legacy single-group channels to the groups-list schema."""
    project.setdefault("channels", _default_channels())
    project.setdefault("groups", dict(DEFAULT_GROUPS))
    project.setdefault("rules", [])

    # Top-up channels list to DEFAULT_CHANNELS so the UI grid is always full
    existing = {c["id"]: c for c in (project.get("channels") or [])}
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
        if proj_path.exists():
            try:
                with proj_path.open("r", encoding="utf-8") as f:
                    project_data = json.load(f)
            except (json.JSONDecodeError, OSError):
                project_data = _empty_project()
        elif legacy_project:
            project_data = legacy_project
            self._write_project_file(current, project_data)
        else:
            project_data = _empty_project()
            self._write_project_file(current, project_data)

        # Fill global defaults for anything the file omitted.
        defaults_g = _default_globals()
        for k, v in defaults_g.items():
            globals_raw.setdefault(k, v)
        globals_raw["current_project"] = current

        project_data = _normalize_project(project_data)

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
