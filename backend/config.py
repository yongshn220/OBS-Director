from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"

DEFAULT_CHANNELS = 32

DEFAULT_GROUPS: dict[str, dict[str, Any]] = {
    "singers":     {"attack_ms": 200, "release_ms": 1500, "color": "#00ff88"},
    "instruments": {"attack_ms": 150, "release_ms": 800,  "color": "#4488ff"},
    "pastor":      {"attack_ms": 150, "release_ms": 1200, "color": "#ffd700"},
}


def _default_config() -> dict[str, Any]:
    channels = []
    for i in range(DEFAULT_CHANNELS):
        channels.append({
            "id": i + 1,
            "name": "",
            "groups": [],
            "threshold_db": -45.0,
        })
    return {
        "audio": {
            "device_name": "X32",
            "device_index": None,
            "channels": DEFAULT_CHANNELS,
            "samplerate": 48000,
            "blocksize": 2048,
            "demo_mode": False,
        },
        "channels": channels,
        "groups": DEFAULT_GROUPS,
        "rules": [],
        "runtime": {
            "auto": True,        # AUTO ON: rule engine drives output. OFF: idle.
            "dry_run": True,     # logs only; no HTTP requests sent until cleared
            "refire_s": 3.0,     # while a rule stays active, re-fire its http
                                 # actions every N seconds (self-healing). 0 = off.
        },
        "connections": {
            # Global default URL used by http_request actions whose own `url`
            # field is empty. Set once in the Connections tab; every rule's
            # action then just supplies a body.
            "ass_http": {"url": "http://localhost:7654/trigger", "method": "POST"},
        },
    }


class ConfigStore:
    """Thread-safe JSON config store. Reloads from disk on each write to keep
    in-memory and on-disk state aligned, but holds the cached dict for fast
    reads from the audio/eval threads."""

    def __init__(self, path: Path = CONFIG_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._data: dict[str, Any] = self._load_or_init()

    def _load_or_init(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                return self._merge_defaults(data)
            except (json.JSONDecodeError, OSError):
                pass
        data = _default_config()
        self._write(data)
        return data

    def _merge_defaults(self, data: dict[str, Any]) -> dict[str, Any]:
        defaults = _default_config()
        for key, val in defaults.items():
            data.setdefault(key, val)
        # Top-up channels list if user added more later
        existing = {c["id"]: c for c in data.get("channels", [])}
        merged_channels = []
        for c in defaults["channels"]:
            merged_channels.append(existing.get(c["id"], c))
        # Migrate legacy single-group channels to a groups list.
        # Old schema:  ch.group: str|None        (one group per channel)
        # New schema:  ch.groups: list[str]      (multi-group per channel)
        for ch in merged_channels:
            if "groups" not in ch:
                legacy = ch.pop("group", None)
                ch["groups"] = [legacy] if legacy else []
            else:
                # Drop stale legacy field if both somehow exist; dedupe; strip falsy
                ch.pop("group", None)
                seen = set()
                ch["groups"] = [
                    g for g in (ch.get("groups") or [])
                    if g and not (g in seen or seen.add(g))
                ]
        data["channels"] = merged_channels
        return data

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp.replace(self.path)

    def get(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._data))

    def update(self, mutator) -> dict[str, Any]:
        """Apply mutator(data) -> data, persist, and return new snapshot."""
        with self._lock:
            new_data = mutator(json.loads(json.dumps(self._data)))
            self._data = new_data
            self._write(new_data)
            return json.loads(json.dumps(new_data))

    def snapshot(self) -> dict[str, Any]:
        """Fast read for hot paths (audio thread). Returns the live dict —
        callers must NOT mutate."""
        with self._lock:
            return self._data
