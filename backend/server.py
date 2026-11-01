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
from .config import (DEFAULT_PACE, PACES, ConfigStore, ProjectNameError,
                     default_profile, new_macro_id)
from .groups import GroupEvaluator, rms_to_db
from .rules import RuleEngine, default_rule, normalize_rule

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

config_store = ConfigStore()
audio = AudioMonitor(config_store)
evaluator = GroupEvaluator(config_store)
rule_engine = RuleEngine(config_store, audio)
clients: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    audio.start()
    audio.start_watchdog()   # detect a dead/wedged device and auto-recover + alarm
    task = asyncio.create_task(_broadcast_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        audio.stop_watchdog()
        audio.stop()


app = FastAPI(title="X32 Auto-Director", lifespan=lifespan)


@app.middleware("http")
async def no_store_cache(request, call_next):
    """This is a live control surface served over localhost; the UI assets
    change often during setup. Tell the browser never to cache so a code
    update never leaves a stale app.js with unbound buttons."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


# ── WebSocket broadcast ──────────────────────────────────────────────

async def _broadcast_loop():
    while True:
        if clients:
            levels = audio.get_levels()
            states = evaluator.evaluate(levels)
            groups = states["groups"]
            roles = states["roles"]
            engine_out = rule_engine.tick(groups, roles)
            rt = config_store.snapshot().get("runtime") or {}
            payload = json.dumps({
                "type": "tick",
                "levels": [round(v, 6) for v in levels],
                "levels_db": [
                    None if (db := rms_to_db(v)) == float("-inf") else round(db, 1)
                    for v in levels
                ],
                "groups": groups,
                "roles": roles,
                # Live runtime toggles so any client (esp. the touch controller)
                # reflects state changed from another device without polling.
                "runtime": {
                    "auto": bool(rt.get("auto", True)),
                    "dry_run": bool(rt.get("dry_run", True)),
                    "director_mode": "dynamic" if rt.get("director_mode") == "dynamic" else "rules",
                    "pace": rt.get("pace", DEFAULT_PACE),
                },
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
    # role/group use model_fields_set so an explicit null clears them; absence
    # leaves them unchanged. Setting a role derives the channel's group from
    # that role; setting group alone (role null) assigns a group directly.
    role: str | None = None
    group: str | None = None
    threshold_db: float | None = None
    beat_source: bool | None = None


@app.patch("/api/channels/{channel_id}")
def patch_channel(channel_id: int, patch: ChannelPatch):
    def mutate(data):
        roles = data.get("roles") or {}
        groups = data.get("groups") or {}
        for ch in data["channels"]:
            if ch["id"] != channel_id:
                continue
            if patch.name is not None:
                ch["name"] = patch.name
            if patch.threshold_db is not None:
                ch["threshold_db"] = float(patch.threshold_db)
            if patch.beat_source is not None:
                ch["beat_source"] = bool(patch.beat_source)
                audio.refresh_beat_channels()
            # Role sets the channel's group (hierarchical): a non-null role
            # derives group from that role, overriding any group in the patch.
            if "role" in patch.model_fields_set:
                r = patch.role or None
                if r is not None and r not in roles:
                    raise HTTPException(400, f"unknown role: {r}")
                ch["role"] = r
                if r is not None:
                    ch["group"] = roles[r].get("group")
            # Group may be set directly only when the channel ends up role-less.
            if "group" in patch.model_fields_set and ch.get("role") is None:
                g = patch.group or None
                if g is not None and g not in groups:
                    raise HTTPException(400, f"unknown group: {g}")
                ch["group"] = g
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
        if name not in data.get("groups", {}):
            raise HTTPException(404, f"group {name} not found")
        del data["groups"][name]
        # Cascade: delete roles that belonged to this group, and detach any
        # channel that held one of those roles or sat directly in the group.
        roles = data.get("roles") or {}
        removed_roles = {r for r, m in roles.items() if (m or {}).get("group") == name}
        for r in removed_roles:
            del roles[r]
        data["roles"] = roles
        for ch in data["channels"]:
            if ch.get("role") in removed_roles:
                ch["role"] = None
            if ch.get("group") == name:
                ch["group"] = None
        return data
    return config_store.update(mutate)


# ── REST: roles (fine subject identities under a group) ──────────────
# A role belongs to one group and inherits its timing: { group, color }.
# Channels pick a role; the role's group becomes the channel's group.

class RoleBody(BaseModel):
    group: str | None = None
    color: str | None = None


@app.put("/api/roles/{name}")
def upsert_role(name: str, body: RoleBody):
    def mutate(data):
        roles = data.setdefault("roles", {})
        existing = roles.get(name, {"group": None, "color": "#888888"})
        if "group" in body.model_fields_set:
            g = body.group or None
            if g is not None and g not in (data.get("groups") or {}):
                raise HTTPException(400, f"unknown group: {g}")
            existing["group"] = g
            # Re-derive the group for every channel currently holding this role.
            for ch in data.get("channels", []):
                if ch.get("role") == name:
                    ch["group"] = g
        if body.color is not None:
            existing["color"] = body.color
        roles[name] = existing
        return data
    return config_store.update(mutate)["roles"]


class ReorderNamesBody(BaseModel):
    order: list[str]


def _reorder_map(data: dict, key: str, order: list[str]) -> dict:
    """Rebuild a name-keyed dict in the given order.

    Order is carried by the dict's own insertion order rather than an explicit
    index field: it is the same thing, and an index would have to be kept
    consistent on every add and delete. Names not listed keep their relative
    position at the end, so a stale client cannot drop entries.
    """
    cur = data.get(key) or {}
    seen, out = set(), {}
    for n in order:
        if n in cur and n not in seen:
            seen.add(n)
            out[n] = cur[n]
    for n, v in cur.items():
        if n not in seen:
            out[n] = v
    data[key] = out
    return data


@app.post("/api/roles/reorder")
def reorder_roles(body: ReorderNamesBody):
    return config_store.update(lambda d: _reorder_map(d, "roles", body.order))["roles"]


@app.post("/api/groups/reorder")
def reorder_groups(body: ReorderNamesBody):
    return config_store.update(lambda d: _reorder_map(d, "groups", body.order))["groups"]


@app.delete("/api/roles/{name}")
def delete_role(name: str):
    def mutate(data):
        roles = data.get("roles") or {}
        if name not in roles:
            raise HTTPException(404, f"role {name} not found")
        del roles[name]
        data["roles"] = roles
        # Detach channels holding this role. Their stored group is already the
        # role's (now former) group, so keep it — they stay in the group,
        # just without a specific role.
        for ch in data["channels"]:
            if ch.get("role") == name:
                ch["role"] = None
        return data
    return config_store.update(mutate)["roles"]


# ── REST: cameras ────────────────────────────────────────────────────
# The physical rig, stated outright so a camera can exist before any shot uses
# it. Sent as a whole list, which covers add / rename / reorder / remove in one
# call and keeps the client from having to diff.

class CamerasBody(BaseModel):
    cameras: list[str]


@app.put("/api/cameras")
def set_cameras(body: CamerasBody):
    def mutate(data):
        wanted, seen = [], set()
        for c in body.cameras:
            c = str(c).strip()
            if c and c not in seen:
                seen.add(c)
                wanted.append(c)
        # Removing a camera that shots still sit on would orphan them into a
        # column that no longer renders, so refuse and say which ones.
        in_use = {str(m["camera"]).strip() for m in data.get("macros", [])
                  if m.get("camera") not in (None, "")}
        orphaned = in_use - seen
        if orphaned:
            names = ", ".join(sorted(orphaned))
            raise HTTPException(400, f"이 카메라를 쓰는 샷이 있습니다: {names}")
        data["cameras"] = wanted
        return data
    return {"cameras": config_store.update(mutate)["cameras"]}


# ── REST: shots (a.k.a. macros) ──────────────────────────────────────
# A shot is a reference to an ASS macro: { id, name, token, camera, subject,
# size }. `token` is the payload POSTed to the ASS HTTP server to fire it;
# `camera` lets the planner avoid cutting a camera to itself; `subjects` lists
# who it covers ("role:X" / "team:Y" / "WIDE"); `size` nudges how long it holds.

class MacroBody(BaseModel):
    name: str | None = None
    token: str | None = None
    camera: str | int | None = None
    # Who this shot covers. A list: one shot can cover several people, and the
    # assignment is edited from the subject's side, not the shot's.
    subjects: list[str] | None = None
    size: str | None = None


@app.get("/api/macros")
def list_macros():
    return config_store.get().get("macros", [])


@app.post("/api/macros")
def create_macro(body: MacroBody):
    macro = {
        "id": new_macro_id(),
        "name": body.name or "",
        "token": body.token or "",
        "camera": body.camera,
        "subjects": body.subjects or [],
        "size": body.size,
    }
    def mutate(data):
        data.setdefault("macros", []).append(macro)
        return data
    cfg = config_store.update(mutate)
    return next((m for m in cfg["macros"] if m["id"] == macro["id"]), macro)


@app.put("/api/macros/{macro_id}")
def update_macro(macro_id: str, body: MacroBody):
    def mutate(data):
        for m in data.get("macros", []):
            if m["id"] == macro_id:
                if body.name is not None:
                    m["name"] = body.name
                if body.token is not None:
                    m["token"] = body.token
                if "camera" in body.model_fields_set:
                    m["camera"] = body.camera
                if "subjects" in body.model_fields_set:
                    m["subjects"] = body.subjects or []
                if body.size is not None:
                    m["size"] = body.size
                return data
        raise HTTPException(404, f"macro {macro_id} not found")
    return config_store.update(mutate)


@app.delete("/api/macros/{macro_id}")
def delete_macro(macro_id: str):
    def mutate(data):
        before = len(data.get("macros", []))
        data["macros"] = [m for m in data.get("macros", []) if m["id"] != macro_id]
        if len(data["macros"]) == before:
            raise HTTPException(404, f"macro {macro_id} not found")
        # _normalize_profile drops this id from any scene that forced it;
        # also release a manual shot pin that pointed at it.
        rt = data.get("runtime") or {}
        if rt.get("override_macro_id") == macro_id:
            rt["override_macro_id"] = None
        return data
    return config_store.update(mutate)


@app.get("/api/scenes/{rule_id}/preview")
def preview_scene(rule_id: str, n: int = 8):
    """A representative shot sequence for a scene, run against the CURRENT
    live activity — so the setup UI shows what this scene would actually do if
    it opened right now, not a sequence read off a fixed list."""
    cfg = config_store.get()
    if rule_id == "__default__":
        profile = (cfg.get("runtime") or {}).get("profile") or default_profile()
    else:
        rule = next((r for r in cfg.get("rules", []) if r["id"] == rule_id), None)
        if rule is None:
            raise HTTPException(404, f"rule {rule_id} not found")
        profile = rule.get("profile") or default_profile()
    states = evaluator.evaluate(audio.get_levels())
    activity = rule_engine.activity(states["groups"], states["roles"])
    seq = rule_engine.preview_profile(cfg, profile, activity, max(1, min(int(n), 30)))
    return {"rule_id": rule_id, "sequence": seq}


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
    # "rules" | "dynamic" — whether rules frame the scene, or the default
    # profile shoots whatever is live regardless of them.
    director_mode: str | None = None
    # The one pacing control: "fast" | "normal" | "slow".
    pace: str | None = None
    # Partial patch of the default scene (see config.DEFAULT_PROFILE).
    profile: dict[str, Any] | None = None


@app.patch("/api/runtime")
def patch_runtime(body: RuntimeBody):
    def mutate(data):
        rt = data.setdefault("runtime", {"auto": True, "dry_run": True})
        if body.auto is not None:
            rt["auto"] = bool(body.auto)
        if body.dry_run is not None:
            rt["dry_run"] = bool(body.dry_run)
        if body.director_mode is not None:
            rt["director_mode"] = "dynamic" if body.director_mode == "dynamic" else "rules"
        if body.pace is not None:
            rt["pace"] = body.pace if body.pace in PACES else DEFAULT_PACE
        if body.profile is not None:
            rt["profile"] = {**(rt.get("profile") or default_profile()), **body.profile}
        return data
    return config_store.update(mutate)["runtime"]


# ── REST: manual overrides (operator pins) ───────────────────────────
# At most one manual selection is active: a SCENE pin or a SHOT pin. Setting
# one clears the other; a null rule_id ("자동/룰") clears both.

class OverrideBody(BaseModel):
    rule_id: str | None = None  # null = release back to rules


@app.post("/api/override")
def set_override(body: OverrideBody):
    def mutate(data):
        rt = data.setdefault("runtime", {})
        rid = body.rule_id or None
        if rid is not None and not any(r.get("id") == rid for r in data.get("rules", [])):
            raise HTTPException(400, f"unknown rule: {rid}")
        rt["override_rule_id"] = rid
        rt["override_macro_id"] = None   # picking a scene (or auto) drops any shot pin
        return data
    return config_store.update(mutate)["runtime"]


class ShotOverrideBody(BaseModel):
    macro_id: str | None = None  # null = release the shot pin


@app.post("/api/override/shot")
def set_shot_override(body: ShotOverrideBody):
    def mutate(data):
        rt = data.setdefault("runtime", {})
        mid = body.macro_id or None
        if mid is not None and not any(m.get("id") == mid for m in data.get("macros", [])):
            raise HTTPException(400, f"unknown macro: {mid}")
        rt["override_macro_id"] = mid
        if mid is not None:
            rt["override_rule_id"] = None   # taking a single shot drops the scene pin
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


@app.get("/control")
def control():
    """Touch controller for phone/iPad — a stripped live-control surface
    (mode toggles + NOW/NEXT + manual shot/transition) over the same API."""
    return FileResponse(WEB_DIR / "control.html")


# ── PWA: service worker (root scope) + manifests ─────────────────────
# The service worker MUST be served from the root so its scope covers both
# "/" and "/control". Manifests are served with the correct content type so
# Chrome/Edge accept them for install.

@app.get("/sw.js")
def service_worker():
    return FileResponse(WEB_DIR / "sw.js", media_type="application/javascript")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(WEB_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/manifest-control.webmanifest")
def manifest_control():
    return FileResponse(WEB_DIR / "manifest-control.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
