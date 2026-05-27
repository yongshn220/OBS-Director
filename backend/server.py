from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .audio import AudioMonitor
from .config import ConfigStore, ProjectNameError
from .groups import GroupEvaluator, rms_to_db
from .rules import RuleEngine, default_rule, normalize_rule

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

config_store = ConfigStore()
audio = AudioMonitor(config_store)
evaluator = GroupEvaluator(config_store)
rule_engine = RuleEngine(config_store)
clients: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    audio.start()
    task = asyncio.create_task(_broadcast_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        audio.stop()


app = FastAPI(title="X32 Auto-Director", lifespan=lifespan)


# ── WebSocket broadcast ──────────────────────────────────────────────

async def _broadcast_loop():
    while True:
        if clients:
            levels = audio.get_levels()
            groups = evaluator.evaluate(levels)
            engine_out = rule_engine.tick(groups)
            payload = json.dumps({
                "type": "tick",
                "levels": [round(v, 6) for v in levels],
                "levels_db": [
                    None if (db := rms_to_db(v)) == float("-inf") else round(db, 1)
                    for v in levels
                ],
                "groups": groups,
                "status": audio.status,
                "engine": engine_out,
                "recent_log": rule_engine.recent_log(20),
            })
            stale = []
            for ws in list(clients):
                try:
                    await ws.send_text(payload)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                clients.discard(ws)
        await asyncio.sleep(0.05)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep alive; we don't expect client msgs yet
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


# ── REST: config ─────────────────────────────────────────────────────

@app.get("/api/config")
def get_config():
    return config_store.get()


# ── REST: projects ───────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects():
    return {
        "current": config_store.snapshot().get("current_project"),
        "projects": config_store.list_projects(),
    }


class ProjectCreateBody(BaseModel):
    name: str
    copy_from: str | None = None


@app.post("/api/projects")
def create_project(body: ProjectCreateBody):
    try:
        name = config_store.create_project(body.name, copy_from=body.copy_from)
    except ProjectNameError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return {"name": name}


class ProjectRenameBody(BaseModel):
    new_name: str


@app.put("/api/projects/{name}")
def rename_project(name: str, body: ProjectRenameBody):
    try:
        new_name = config_store.rename_project(name, body.new_name)
    except ProjectNameError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return {"name": new_name}


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    try:
        config_store.delete_project(name)
    except ProjectNameError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return {"deleted": name}


@app.post("/api/projects/{name}/activate")
def activate_project(name: str):
    try:
        cfg = config_store.activate_project(name)
    except ProjectNameError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return cfg


class ChannelPatch(BaseModel):
    name: str | None = None
    # None  → no change to group membership
    # []    → clear all groups
    # [...] → replace with exactly this set (deduped, validated)
    groups: list[str] | None = None
    threshold_db: float | None = None


@app.patch("/api/channels/{channel_id}")
def patch_channel(channel_id: int, patch: ChannelPatch):
    def mutate(data):
        for ch in data["channels"]:
            if ch["id"] == channel_id:
                if patch.name is not None:
                    ch["name"] = patch.name
                if patch.threshold_db is not None:
                    ch["threshold_db"] = float(patch.threshold_db)
                if patch.groups is not None:
                    seen = set()
                    cleaned: list[str] = []
                    for g in patch.groups:
                        if not g or g in seen:
                            continue
                        if g not in data["groups"]:
                            raise HTTPException(400, f"unknown group: {g}")
                        seen.add(g)
                        cleaned.append(g)
                    ch["groups"] = cleaned
                return data
        raise HTTPException(404, f"channel {channel_id} not found")
    return config_store.update(mutate)


class GroupBody(BaseModel):
    attack_ms: float | None = None
    release_ms: float | None = None
    color: str | None = None


@app.put("/api/groups/{name}")
def upsert_group(name: str, body: GroupBody):
    def mutate(data):
        existing = data["groups"].get(name, {"attack_ms": 200, "release_ms": 1000, "color": "#888888"})
        if body.attack_ms is not None:
            existing["attack_ms"] = float(body.attack_ms)
        if body.release_ms is not None:
            existing["release_ms"] = float(body.release_ms)
        if body.color is not None:
            existing["color"] = body.color
        data["groups"][name] = existing
        return data
    return config_store.update(mutate)


@app.delete("/api/groups/{name}")
def delete_group(name: str):
    def mutate(data):
        if name not in data["groups"]:
            raise HTTPException(404, f"group {name} not found")
        del data["groups"][name]
        # Detach channels from this group (remove name from their groups list)
        for ch in data["channels"]:
            gs = ch.get("groups") or []
            if name in gs:
                ch["groups"] = [g for g in gs if g != name]
        return data
    return config_store.update(mutate)


# ── REST: rules ──────────────────────────────────────────────────────

@app.get("/api/rules")
def list_rules():
    return config_store.get()["rules"]


@app.post("/api/rules")
def create_rule(body: dict[str, Any] | None = None):
    new_rule = normalize_rule({**default_rule(), **(body or {})})
    def mutate(data):
        # Place at top of list with the highest priority + 10 (so newly-created
        # rules visibly appear and don't get drowned by existing ones).
        max_pri = max((r.get("priority", 0) for r in data["rules"]), default=0)
        new_rule["priority"] = max_pri + 10
        data["rules"].insert(0, new_rule)
        return data
    config_store.update(mutate)
    return new_rule


@app.put("/api/rules/{rule_id}")
def update_rule(rule_id: str, body: dict[str, Any]):
    def mutate(data):
        for i, r in enumerate(data["rules"]):
            if r["id"] == rule_id:
                merged = normalize_rule({**r, **body, "id": rule_id})
                data["rules"][i] = merged
                return data
        raise HTTPException(404, f"rule {rule_id} not found")
    return config_store.update(mutate)


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: str):
    def mutate(data):
        before = len(data["rules"])
        data["rules"] = [r for r in data["rules"] if r["id"] != rule_id]
        if len(data["rules"]) == before:
            raise HTTPException(404, f"rule {rule_id} not found")
        return data
    return config_store.update(mutate)


class ReorderBody(BaseModel):
    order: list[str]  # list of rule_ids in desired top→bottom order (top = highest priority)


@app.post("/api/rules/{rule_id}/run")
def run_rule_manual(rule_id: str):
    try:
        return rule_engine.fire_manual(rule_id)
    except KeyError:
        raise HTTPException(404, f"rule {rule_id} not found")


@app.post("/api/rules/reorder")
def reorder_rules(body: ReorderBody):
    def mutate(data):
        idx = {rid: i for i, rid in enumerate(body.order)}
        # Stable sort: known IDs by their explicit order, unknown ids appended after.
        data["rules"].sort(key=lambda r: idx.get(r["id"], 10_000))
        # Reassign priority by position so engine ordering matches UI.
        n = len(data["rules"])
        for i, r in enumerate(data["rules"]):
            r["priority"] = (n - i) * 10
        return data
    return config_store.update(mutate)


# ── REST: runtime (AUTO/MANUAL, dry_run) ─────────────────────────────

class RuntimeBody(BaseModel):
    auto: bool | None = None
    dry_run: bool | None = None


@app.patch("/api/runtime")
def patch_runtime(body: RuntimeBody):
    def mutate(data):
        rt = data.setdefault("runtime", {"auto": True, "dry_run": True})
        if body.auto is not None:
            rt["auto"] = bool(body.auto)
        if body.dry_run is not None:
            rt["dry_run"] = bool(body.dry_run)
        return data
    return config_store.update(mutate)["runtime"]


# ── REST: ASS HTTP global default ────────────────────────────────────

class AssHttpBody(BaseModel):
    url: str | None = None
    method: str | None = None


@app.patch("/api/connections/ass_http")
def patch_ass_http(body: AssHttpBody):
    def mutate(data):
        conn = data.setdefault("connections", {}).setdefault(
            "ass_http", {"url": "", "method": "POST"}
        )
        if body.url is not None:
            conn["url"] = body.url.strip()
        if body.method is not None:
            m = body.method.upper().strip()
            conn["method"] = "GET" if m == "GET" else "POST"
        return data
    return config_store.update(mutate)["connections"]["ass_http"]


# ── REST: devices / status ───────────────────────────────────────────

@app.get("/api/devices")
def list_devices():
    return {
        "devices": audio.list_devices(),
        "current_status": audio.status,
    }


@app.post("/api/audio/restart")
def restart_audio():
    audio.stop()
    audio.start()
    return audio.status


# ── Static UI ────────────────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
