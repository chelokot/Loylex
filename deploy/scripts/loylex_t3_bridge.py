"""T3 approval policy and host-owned connection registry."""
from collections import deque
import hashlib
import json
import re
import stat
import threading
import time
import uuid
from pathlib import Path

from loylex_approval_host import ApprovalError, encoded, secret
from loylex_t3_transport import T3Transport

IDENTIFIER = re.compile(r"[a-zA-Z0-9_.:-]{1,256}\Z")
NAME = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
STATUSES = {"idle", "queued", "preparing", "starting", "running", "waiting", "completed",
            "failed", "cancelled", "interrupted", "rolled_back"}
TOOLS = {"launch": "t3_thread_launch", "send": "t3_thread_send", "read": "t3_thread_read",
         "list": "t3_thread_list", "interrupt": "t3_thread_interrupt",
         "projects": "t3_project_list", "capabilities": "orchestrator_capabilities"}
FIELDS = {
    "launch": ({"projectId", "title", "message"}, set()),
    "send": ({"projectId", "threadId", "message"}, set()),
    "read": ({"threadId"}, {"afterPosition", "limit", "maxCharsPerItem"}),
    "list": ({"projectId"}, {"cursor", "limit"}),
    "interrupt": ({"threadId"}, set()),
    "projects": (set(), {"cursor", "limit"}),
    "capabilities": (set(), set()),
}
SLOTS = threading.BoundedSemaphore(2)
STATUS_LOCK = threading.Lock()
STATUS_TIMES: deque[float] = deque()


def validate_t3(operation: dict) -> None:
    if set(operation) != {"kind", "machine", "action", "arguments"} or operation["kind"] != "t3":
        raise ApprovalError("Invalid T3 operation fields")
    if not isinstance(operation["machine"], str) or not NAME.fullmatch(operation["machine"]):
        raise ApprovalError("Invalid T3 machine")
    action, args = operation["action"], operation["arguments"]
    if not isinstance(action, str) or action not in FIELDS or not isinstance(args, dict):
        raise ApprovalError("Unsupported T3 operation")
    required, optional = FIELDS[action]
    if not required <= set(args) <= required | optional:
        raise ApprovalError("Invalid T3 arguments")
    for key, value in args.items():
        if key in {"afterPosition", "cursor", "limit", "maxCharsPerItem"}:
            maximum = 50000 if key == "maxCharsPerItem" else 100 if key == "limit" else 1000000000
            minimum = 1 if key in {"limit", "maxCharsPerItem"} else 0
            if type(value) is not int or not minimum <= value <= maximum:
                raise ApprovalError("Invalid T3 pagination")
        elif not isinstance(value, str) or not value.strip() or len(value) > (
            120000 if key == "message" else 512 if key == "title" else 256
        ) or any(ord(c) < 32 for c in value if key not in {"message", "title"}):
            raise ApprovalError("Invalid T3 text argument")


def connection(machine: str) -> dict:
    path = Path.home() / ".config/loylex/t3-machines.json"
    if not path.is_file() or path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ApprovalError("Host T3 registry must be a regular mode-0600 file")
    if path.stat().st_size > 65536:
        raise ApprovalError("Host T3 registry exceeds limit")
    registry = json.loads(path.read_text())
    if not isinstance(registry, dict) or len(registry) > 20:
        raise ApprovalError("Invalid host T3 registry")
    entry = registry.get(machine)
    if not isinstance(entry, dict) or set(entry) != {"endpoint", "tokenSecret", "projects"}:
        raise ApprovalError("T3 machine is not configured on the host")
    if not isinstance(entry["tokenSecret"], str) or not re.fullmatch(r"loylex-t3-[a-z0-9-]+", entry["tokenSecret"]):
        raise ApprovalError("Invalid T3 secret reference")
    projects = entry["projects"]
    if not isinstance(projects, dict) or any(
        not isinstance(key, str) or not IDENTIFIER.fullmatch(key) or
        not isinstance(value, str) or not value or len(value) > 4096 or
        any(ord(c) < 32 for c in value) for key, value in projects.items()
    ):
        raise ApprovalError("Invalid host T3 project registry")
    # Endpoint validation happens even at preflight, without reading a credential.
    T3Transport(entry["endpoint"], "preflight")
    return entry


def snapshot_t3(operation: dict) -> dict:
    validate_t3(operation)
    entry = connection(operation["machine"])
    project = operation["arguments"].get("projectId")
    if operation["action"] in {"launch", "send"} and project not in entry["projects"]:
        raise ApprovalError("T3 project folder must be registered on the host")
    target = {key: entry[key] for key in ("endpoint", "tokenSecret")}
    return {**operation, "connection": target, "requestKey": uuid.uuid4().hex,
            "workspaceRoot": entry["projects"].get(project),
            "connectionSha256": hashlib.sha256(encoded(entry)).hexdigest(),
            "executionMode": "full-access", "resultAccess": "requesting-agent"}


def call_t3(entry: dict, tool: str, arguments: dict) -> dict:
    if not SLOTS.acquire(blocking=False):
        raise ApprovalError("T3 bridge is busy")
    try:
        return T3Transport(entry["endpoint"], secret(entry["tokenSecret"])).call(tool, arguments)
    finally:
        SLOTS.release()


def receipt(value: dict) -> dict:
    # Mutation receipts cannot become a side channel for session content.
    result = {}
    for key in ("threadId", "runId", "messageId"):
        if key in value:
            item = value[key]
            if item is not None and (not isinstance(item, str) or not IDENTIFIER.fullmatch(item)):
                raise ApprovalError("Invalid T3 receipt identifier")
            result[key] = item
    if "status" in value:
        status = value["status"]
        if status is not None and (not isinstance(status, str) or status not in STATUSES | {"interrupt_requested", "no_active_run"}):
            raise ApprovalError("Invalid T3 receipt status")
        result["status"] = status
    if "threadId" not in result:
        raise ApprovalError("Missing T3 receipt thread identifier")
    return result


def execute_t3(saved: dict) -> dict:
    operation = {key: saved[key] for key in ("kind", "machine", "action", "arguments")}
    validate_t3(operation)
    entry = connection(operation["machine"])
    target = {key: entry[key] for key in ("endpoint", "tokenSecret")}
    if target != saved["connection"] or hashlib.sha256(encoded(entry)).hexdigest() != saved["connectionSha256"]:
        raise ApprovalError("T3 connection changed; submit a new request")
    action = operation["action"]
    args = dict(operation["arguments"])
    if action in {"launch", "send"}:
        project_id = args["projectId"]
        actual = call_t3(entry, "t3_project_read", {"projectId": project_id})
        if actual.get("workspaceRoot") != saved["workspaceRoot"]:
            raise ApprovalError("T3 project folder changed; submit a new request")
        args["clientRequestId"] = saved["requestKey"]
    if action == "launch":
        args.update(runtimeMode="full-access", interactionMode="default", workspaceStrategy={"type": "root"})
    elif action == "send":
        project_id = args.pop("projectId")
        found = False
        for cursor in range(0, 1000, 100):
            shells = call_t3(entry, "t3_thread_list", {"projectId": project_id, "cursor": cursor, "limit": 100})
            for shell in shells.get("threads", []):
                if shell.get("threadId") == args["threadId"]:
                    if shell.get("runtimeMode") != "full-access" or shell.get("interactionMode") != "default":
                        raise ApprovalError("T3 session is not in full-access/default mode; no message sent")
                    found = True
                    break
            if found or shells.get("nextCursor") is None:
                break
        if not found:
            raise ApprovalError("T3 session not found in first 1000 project sessions; no message sent")
        args["mode"] = "queue"
    elif action == "read":
        args.update(view="messages", runLimit=1)
        args.setdefault("limit", 20)
        args.setdefault("maxCharsPerItem", 10000)
    elif action == "interrupt":
        args["stop"] = True
    value = call_t3(entry, TOOLS[action], args)
    return receipt(value) if action in {"launch", "send", "interrupt"} else value


def t3_status(payload: dict) -> dict:
    if set(payload) != {"machine", "threadId"}:
        raise ApprovalError("Expected machine and threadId")
    if (not isinstance(payload["machine"], str) or not NAME.fullmatch(payload["machine"]) or
            not isinstance(payload["threadId"], str) or not IDENTIFIER.fullmatch(payload["threadId"])):
        raise ApprovalError("Invalid T3 status target")
    with STATUS_LOCK:
        now = time.monotonic()
        while STATUS_TIMES and STATUS_TIMES[0] <= now - 60:
            STATUS_TIMES.popleft()
        if len(STATUS_TIMES) >= 120:
            raise ApprovalError("T3 status rate limit reached")
        STATUS_TIMES.append(now)
    # wait returns run state only, unlike read/list/task_status which expose content.
    value = call_t3(connection(payload["machine"]), "t3_thread_wait", {
        "threadId": payload["threadId"], "timeoutMs": 1,
    })
    if value.get("threadId") != payload["threadId"] or value.get("status") not in STATUSES:
        raise ApprovalError("Invalid T3 status response")
    checked = receipt(value)
    return {"machine": payload["machine"], **{key: checked.get(key) for key in ("threadId", "runId", "status")}}
