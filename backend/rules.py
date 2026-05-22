from __future__ import annotations

import logging
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

    Only `http_request` actions are supported; any other action type is
    dropped silently.
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
        if a.get("type") != "http_request":
            continue  # unsupported action types are dropped silently
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
    return r


class RuleEngine:
    """Evaluates rules against group activity each tick.

    Match semantics:
      - Rules walked in descending priority order.
      - First enabled rule whose ALL conditions are satisfied is the candidate.
      - Empty conditions list ⇒ always satisfied (catch-all rule).
      - Condition: group must currently be in the specified state (active/inactive).

    Transition semantics:
      - When the candidate differs from the currently active rule, switch only
        if `now - active_since >= active_rule.cooldown_s` (unless the candidate
        has strictly higher priority, which preempts immediately).
      - On switch, fire the active rule's http_request actions immediately.
      - While the rule remains active, re-fire those actions every
        `runtime.refire_s` seconds as a self-healing heartbeat (so the
        downstream HTTP target self-recovers from restarts / dropped packets).
        Set refire_s to 0 to disable and keep only the one-shot transition fire.
    """

    LOG_MAX = 100
    DEFAULT_REFIRE_S = 3.0

    def __init__(self, config_store):
        self.config_store = config_store
        self.active_rule_id: str | None = None
        self.active_since: float = 0.0
        # rule_id -> next monotonic time at which a refire should fire.
        # Populated on transition; cleared on release/switch.
        self._refire_at: dict[str, float] = {}
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

        # Sort enabled rules by priority desc, original order as tiebreaker
        ordered = sorted(
            [r for r in rules if r.get("enabled", True)],
            key=lambda r: (-int(r.get("priority", 0)),),
        )

        # Find ALL matching rules in priority order — used both for the
        # active-rule decision and for the live "match queue" UI.
        matching = [r for r in ordered if self._match(r, group_states)]
        candidate = matching[0] if matching else None
        fired: list[dict[str, Any]] = []

        # Decide whether to switch
        switch_to: dict[str, Any] | None = None
        if candidate is None:
            # No match → if currently active, only release after cooldown
            if self.active_rule_id is not None:
                active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
                cooldown = float(active_rule.get("cooldown_s", 0.0)) if active_rule else 0.0
                if now - self.active_since >= cooldown:
                    self._refire_at.pop(self.active_rule_id, None)
                    self.active_rule_id = None
                    self.active_since = now
        else:
            cand_id = candidate["id"]
            if cand_id != self.active_rule_id:
                # Honor the active rule's cooldown by default, UNLESS the
                # candidate has strictly higher priority (urgent barge-in).
                allow = True
                if self.active_rule_id is not None:
                    active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
                    cd = float(active_rule.get("cooldown_s", 0.0)) if active_rule else 0.0
                    active_pri = int(active_rule.get("priority", 0)) if active_rule else 0
                    cand_pri = int(candidate.get("priority", 0))
                    if now - self.active_since < cd and cand_pri <= active_pri:
                        allow = False
                if allow:
                    switch_to = candidate

        if switch_to is not None:
            # If we were holding a different rule, drop its refire schedule.
            if self.active_rule_id is not None and self.active_rule_id != switch_to["id"]:
                self._refire_at.pop(self.active_rule_id, None)
            self.active_rule_id = switch_to["id"]
            self.active_since = now
            for action in switch_to.get("actions", []):
                if action["type"] == "http_request":
                    fired.append(self._fire(switch_to, action, dry_run, now, "transition"))
            # Arm the refire heartbeat (disabled when refire_s <= 0).
            if refire_s > 0:
                self._refire_at[switch_to["id"]] = now + refire_s

        # Refire heartbeat: while the rule is held, re-fire its http_request
        # actions every refire_s seconds so the downstream target self-heals.
        if self.active_rule_id is not None and refire_s > 0:
            next_at = self._refire_at.get(self.active_rule_id)
            if next_at is None:
                # Just-activated rules already armed above; this covers rules
                # that became active before refire_s was set (config edit).
                self._refire_at[self.active_rule_id] = now + refire_s
            elif now >= next_at:
                active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
                if active_rule is not None:
                    for action in active_rule.get("actions", []):
                        if action["type"] == "http_request":
                            fired.append(self._fire(active_rule, action, dry_run, now, "refire"))
                self._refire_at[self.active_rule_id] = now + refire_s

        active_name = None
        active_rule_cooldown_remaining = None
        if self.active_rule_id is not None:
            active_rule = next((r for r in rules if r["id"] == self.active_rule_id), None)
            if active_rule:
                active_name = active_rule.get("name")
                cd = float(active_rule.get("cooldown_s", 0.0))
                active_rule_cooldown_remaining = max(0.0, cd - (now - self.active_since))
            else:
                # Rule was deleted while active
                self._refire_at.pop(self.active_rule_id, None)
                self.active_rule_id = None

        # Build the live "match queue" — every rule currently matching,
        # priority desc, with a brief preview of what each would do.
        queue: list[dict[str, Any]] = []
        for r in matching:
            queue.append({
                "id": r["id"],
                "name": r.get("name"),
                "priority": int(r.get("priority", 0)),
                "is_active": r["id"] == self.active_rule_id,
                "preview": self._next_action_preview(r),
            })

        return {
            "active_rule_id": self.active_rule_id,
            "active_rule_name": active_name,
            "active_cooldown_remaining": (
                round(active_rule_cooldown_remaining, 2)
                if active_rule_cooldown_remaining is not None else None
            ),
            "fired": fired,
            "dry_run": dry_run,
            "matching": queue,
        }

    def recent_log(self, limit: int = 30) -> list[dict[str, Any]]:
        return list(self._action_log)[-limit:]

    def fire_manual(self, rule_id: str) -> dict[str, Any]:
        """Fire a rule's actions immediately, ignoring its conditions.

        Used by the UI's per-rule "Run" button so users can verify the HTTP
        wiring without having to physically trigger the audio condition.
        Honors `runtime.dry_run`. Does NOT update active_rule_id — manual
        fires are isolated from the engine's state machine.
        """
        cfg = self.config_store.snapshot()
        rule = next((r for r in (cfg.get("rules") or []) if r["id"] == rule_id), None)
        if rule is None:
            raise KeyError(rule_id)
        dry_run = bool((cfg.get("runtime") or {}).get("dry_run", True))
        now = time.monotonic()
        fired: list[dict[str, Any]] = []
        for action in rule.get("actions", []):
            if action["type"] == "http_request":
                fired.append(self._fire(rule, action, dry_run, now, cause="manual"))
        return {"rule_id": rule_id, "rule_name": rule.get("name"), "fired": fired, "dry_run": dry_run}

    # ── Internal ──────────────────────────────────────────────────

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

    def _fire(self, rule: dict[str, Any], action: dict[str, Any],
              dry_run: bool, now: float, cause: str) -> dict[str, Any]:
        evt = {
            "ts": now,
            "wall_ts": time.time(),
            "rule_id": rule["id"],
            "rule_name": rule.get("name"),
            "type": action["type"],
            "detail": self._action_detail(action),
            "dry_run": dry_run,
            "cause": cause,
            "dispatched": False,
            "dispatch_error": None,
        }
        if not dry_run:
            try:
                evt["dispatched"] = self._dispatch(action) or False
            except Exception as e:
                evt["dispatch_error"] = str(e)
        self._action_log.append(evt)
        return evt

    def _dispatch(self, action: dict[str, Any]) -> bool:
        """Send the http_request action. Returns True if the request was
        dispatched (fired on a daemon thread; success means "sent")."""
        if action["type"] != "http_request":
            return False
        url = (action.get("url") or "").strip()
        method = (action.get("method") or "").upper().strip()
        # Fall back to the global ASS HTTP defaults when the per-action
        # fields are empty — the simplified UI uses this exclusively.
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
        # Fire on a daemon thread — never block the engine tick on a
        # network call. We don't await the response; success means "sent".
        threading.Thread(
            target=self._do_http,
            args=(method, url, body),
            daemon=True,
            name="http-dispatch",
        ).start()
        return True

    def _next_action_preview(self, rule: dict[str, Any]) -> str:
        """Short description of what this rule's first action would emit."""
        actions = rule.get("actions") or []
        if not actions:
            return "(no actions)"
        a = actions[0]
        body = a.get("body") or ""
        if len(body) > 40:
            body = body[:38] + "…"
        return f"HTTP body: {body}" if body else "HTTP (no body)"

    @staticmethod
    def _action_detail(action: dict[str, Any]) -> str:
        url = action.get("url") or "(global)"
        method = action.get("method") or "POST"
        return f"HTTP {method} → {url}"

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
