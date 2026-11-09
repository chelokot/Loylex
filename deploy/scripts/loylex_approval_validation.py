from collections import deque
import hashlib
import json
import re
import threading
import time
import uuid
from typing import Any

from loylex_approval_host import ApprovalError, T3Transport, command, encoded, secret, t3_read, t3_write, t3_endpoint


MAX_BUNDLE_BYTES = 20 * 1024 * 1024
REPOSITORY_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


class OperationValidation:
    @staticmethod
    def _validate_operation(operation: Any) -> None:
        if not isinstance(operation, dict):
            raise ApprovalError("operation must be an object")
        kind = operation.get("kind")
        if kind == "t3":
            validate_t3(operation)
            return
        fields = {
            "push": {"kind", "repository", "ref", "newSha", "bundle"},
            "pull-request": {"kind", "repository", "head", "base", "title", "body"},
            "github": {"kind", "repository", "method", "resource", "body"},
            "gateway": {"kind", "commit"},
            "infrastructure": {"kind", "commit"},
        }
        if kind not in fields or set(operation) not in (
            fields[kind],
            fields[kind] | ({"headRepository"} if kind == "pull-request" else set()),
        ):
            raise ApprovalError("Invalid operation fields")
        if kind in {"gateway", "infrastructure"}:
            if not isinstance(operation["commit"], str) or not SHA_PATTERN.fullmatch(
                operation["commit"]
            ):
                raise ApprovalError("A full commit SHA is required")
            return
        repositories = [operation["repository"]]
        if "headRepository" in operation:
            repositories.append(operation["headRepository"])
        for repository in repositories:
            if (
                not isinstance(repository, str)
                or not REPOSITORY_PATTERN.fullmatch(repository)
                or ".." in repository
            ):
                raise ApprovalError("repository must be owner/name")
        if kind == "push":
            if not isinstance(operation["ref"], str) or not operation["ref"].startswith(
                ("refs/heads/", "refs/tags/")
            ):
                raise ApprovalError("Only branch and tag refs can be pushed")
            command(["git", "check-ref-format", operation["ref"]])
            if not isinstance(operation["newSha"], str) or not SHA_PATTERN.fullmatch(
                operation["newSha"]
            ):
                raise ApprovalError("A full newSha is required")
            if (
                not isinstance(operation["bundle"], str)
                or len(operation["bundle"]) > MAX_BUNDLE_BYTES * 4 // 3 + 4
            ):
                raise ApprovalError("Bundle exceeds size limit")
        if kind == "pull-request":
            for key in ("head", "base"):
                if not isinstance(operation[key], str):
                    raise ApprovalError(
                        "head and base must be branch names"
                    )
                command(["git", "check-ref-format", f"refs/heads/{operation[key]}"])
            if (
                not isinstance(operation["title"], str)
                or not operation["title"].strip()
                or len(operation["title"]) > 256
            ):
                raise ApprovalError("Invalid PR title")
            if not isinstance(operation["body"], str) or len(operation["body"]) > 60000:
                raise ApprovalError("Invalid PR body")
        if kind == "github":
            resource = operation["resource"]
            if operation["method"] not in {
                "POST",
                "PATCH",
                "PUT",
                "DELETE",
            } or not isinstance(operation["body"], dict):
                raise ApprovalError("Invalid GitHub method or body")
            if not isinstance(resource, str) or not re.fullmatch(
                r"(?:issues|pulls|releases|dispatches|actions/workflows)(?:/[A-Za-z0-9_.-]+)*",
                resource,
            ):
                raise ApprovalError("Unsupported GitHub resource")
            if any(part in {".", ".."} for part in resource.split("/")):
                raise ApprovalError("Invalid GitHub resource path")
            if resource == "pulls" or resource.startswith("pulls/"):
                raise ApprovalError(
                    "Use pull-request for PR creation; other PR mutations need a new supported operation"
                )


# T3 operation policy. No new installation paths are required on existing hosts.
IDENTIFIER = re.compile(r"[a-zA-Z0-9_.:-]{1,256}\Z")
NAME = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
STATUSES = {"idle", "queued", "preparing", "starting", "running", "waiting", "completed",
            "failed", "cancelled", "interrupted", "rolled_back"}
TOOLS = {"launch": "t3_thread_launch", "export": "t3_thread_launch", "send": "t3_thread_send", "read": "t3_thread_read",
         "list": "t3_thread_list", "interrupt": "t3_thread_interrupt",
         "projects": "t3_project_list", "capabilities": "orchestrator_capabilities"}
FIELDS = {
    "launch": ({"projectId", "title", "message"}, set()),
    "send": ({"projectId", "threadId", "message"}, set()),
    "read": ({"threadId"}, {"afterPosition", "itemId", "textOffset", "limit", "maxCharsPerItem"}),
    "export": ({"projectId", "path"}, set()),
    "connect": (set(), {"endpoint", "environmentName"}),
    "confirm-connect": ({"attemptId"}, set()),
    "register": ({"projectId", "workspaceRoot"}, set()),
    "disconnect": (set(), set()),
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
        if key in {"afterPosition", "textOffset", "cursor", "limit", "maxCharsPerItem"}:
            maximum = 50000 if key == "maxCharsPerItem" else 100 if key == "limit" else 1000000000
            minimum = 1 if key in {"limit", "maxCharsPerItem"} else 0
            if type(value) is not int or not minimum <= value <= maximum:
                raise ApprovalError("Invalid T3 pagination")
        elif not isinstance(value, str) or not value.strip() or len(value) > (
            120000 if key == "message" else 4096 if key == "workspaceRoot" else 512 if key in {"title", "endpoint"} else 256
        ) or any(ord(c) < 32 for c in value if key not in {"message", "title"}):
            raise ApprovalError("Invalid T3 text argument")
    if action == 'export':
        path = args['path']
        if len(path) > 240 or path.startswith(('/', '\\')) or '\\' in path or ':' in path or any(part in {'', '.', '..'} for part in path.split('/')):
            raise ApprovalError('Export requires a relative project file path without traversal')
    if action == "connect":
        if len(args) != 1:
            raise ApprovalError("Choose exactly one T3 endpoint or environment name")
        if "endpoint" in args:
            t3_endpoint(args["endpoint"])
    if "textOffset" in args and "itemId" not in args:
        raise ApprovalError("Text continuation requires itemId")


def connection(machine: str) -> dict:
    registry = t3_read('t3-machines.json', {})
    if not isinstance(registry, dict) or len(registry) > 20:
        raise ApprovalError("Invalid host T3 registry")
    entry = registry.get(machine)
    if not isinstance(entry, dict) or entry.get('disabled'):
        raise ApprovalError("T3 computer disconnected; use loylex t3 connect")
    fields = set(entry)
    if fields not in ({'endpoint', 'tokenSecret', 'projects'}, {'endpoint', 'grantId', 'projects'}):
        raise ApprovalError("Invalid T3 computer registration")
    if 'tokenSecret' in entry and (not isinstance(entry['tokenSecret'], str) or not re.fullmatch(r'loylex-t3-[a-z0-9-]+', entry['tokenSecret'])):
        raise ApprovalError('Invalid T3 secret reference')
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
    if operation['action'] == 'confirm-connect':
        from loylex_supervisor_http import T3_OAUTH
        return {**operation, 'confirmation': T3_OAUTH.confirmation(operation['machine'], operation['arguments']['attemptId'])}
    if operation['action'] == 'connect':
        from loylex_supervisor_http import T3_OAUTH
        flow = T3_OAUTH.configuration()
        old = t3_read('t3-machines.json', {}).get(operation['machine'])
        return {**operation, 'oldDigest': hashlib.sha256(encoded(old)).hexdigest(), 'loginFlow': flow, 'enrollment': 'Temporary T3 account login to identify a computer; a separate operator confirmation is required before a full-access MCP grant is created.'}
    entry = connection(operation["machine"])
    project = operation["arguments"].get("projectId")
    if operation["action"] in {"launch", "send", "export"} and project not in entry["projects"]:
        raise ApprovalError("T3 project folder must be registered on the host")
    target = {key: entry[key] for key in ("endpoint", "tokenSecret", "grantId") if key in entry}
    return {**({"exportPrompt": export_prompt(operation["arguments"]["path"])} if operation["action"] == "export" else {}), **operation, "connection": target, "requestKey": uuid.uuid4().hex,
            "workspaceRoot": entry["projects"].get(project),
            "connectionSha256": hashlib.sha256(encoded(entry)).hexdigest(),
            "executionMode": "full-access", "resultAccess": "requesting-agent"}


def call_t3(entry: dict, tool: str, arguments: dict) -> dict:
    if not SLOTS.acquire(blocking=False):
        raise ApprovalError("T3 bridge is busy")
    try:
        if 'tokenSecret' in entry:
            token = secret(entry['tokenSecret'])
        else:
            credential = t3_read('t3-credentials.json', {}).get(next((name for name, item in t3_read('t3-machines.json', {}).items() if item == entry), ''), {})
            if credential.get('grantId') != entry['grantId'] or credential.get('expiresAt', 0) <= time.time() + 30:
                raise ApprovalError('T3 access expired or changed; reconnect this computer')
            token = credential['accessToken']
        return T3Transport(entry["endpoint"], token).call(tool, arguments)
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


def execute_t3(saved: dict, notify: Any = None) -> dict:
    operation = {key: saved[key] for key in ("kind", "machine", "action", "arguments")}
    validate_t3(operation)
    if operation['action'] == 'confirm-connect':
        from loylex_supervisor_http import T3_OAUTH
        return T3_OAUTH.complete(operation['machine'], saved['confirmation'])
    if operation['action'] == 'connect':
        from loylex_supervisor_http import T3_OAUTH
        with T3_OAUTH.lock:
            old = t3_read('t3-machines.json', {}).get(operation['machine'])
            if hashlib.sha256(encoded(old)).hexdigest() != saved['oldDigest'] or T3_OAUTH.configuration() != saved.get('loginFlow'):
                raise ApprovalError('T3 connection target changed; submit a new request')
            return T3_OAUTH.begin(operation['machine'], **operation['arguments'], notify=notify)
    entry = connection(operation["machine"])
    target = {key: entry[key] for key in ("endpoint", "tokenSecret", "grantId") if key in entry}
    if target != saved["connection"] or hashlib.sha256(encoded(entry)).hexdigest() != saved["connectionSha256"]:
        raise ApprovalError("T3 connection changed; submit a new request")
    action = operation["action"]
    args = dict(operation["arguments"])
    if action in {'register', 'disconnect'}:
        from loylex_supervisor_http import T3_OAUTH
        with T3_OAUTH.lock:
            registry = t3_read('t3-machines.json', {})
            if registry.get(operation['machine']) != entry:
                raise ApprovalError('T3 connection changed; submit a new request')
            if action == 'register':
                project = call_t3(entry, 't3_project_read', {'projectId': args['projectId']})
                if project.get('workspaceRoot') != args['workspaceRoot']:
                    raise ApprovalError('T3 project folder does not match the approved folder')
                entry['projects'][args['projectId']] = args['workspaceRoot']
            else:
                entry['disabled'] = True
                pending = t3_read('t3-pending.json', {})
                cancelled = pending.pop(operation['machine'], {})
                T3_OAUTH.expire(cancelled.get('attemptId'))
                t3_write('t3-pending.json', pending)
            registry[operation['machine']] = entry
            t3_write('t3-machines.json', registry)
            return {'machine': operation['machine'], 'state': 'project_registered' if action == 'register' else 'disconnected'}
    if action in {"launch", "send", "export"}:
        project_id = args["projectId"]
        actual = call_t3(entry, "t3_project_read", {"projectId": project_id})
        if actual.get("workspaceRoot") != saved["workspaceRoot"]:
            raise ApprovalError("T3 project folder changed; submit a new request")
        args["clientRequestId"] = saved["requestKey"]
    if action == 'export':
        path = args.pop('path')
        if saved.get('exportPrompt') != export_prompt(path):
            raise ApprovalError('Export instructions changed; submit a new request')
        args.update(title='Export ' + path, message=export_prompt(path))
    if action in {'launch', 'export'}:
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
    return receipt(value) if action in {"launch", "send", "interrupt", "export"} else value


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


def t3_connection_status(payload: dict) -> dict:
    from loylex_supervisor_http import T3_OAUTH
    return T3_OAUTH.status(payload)


def export_prompt(path: str) -> str:
    return ('Export exactly this project-relative file: ' + json.dumps(path) +
            '. Resolve its real path first; refuse symlinks escaping the project root, non-regular files, '
            'credentials/secrets and files larger than 32768 bytes. Do not modify anything. '
            'Return only a JSON object (no markdown): {"loylexExport":1,"path":<the exact requested relative path>,'
            '"size":<byte count>,"sha256":<SHA-256 hex of original bytes>,"base64":<base64 of original bytes>}. '
            'If you cannot safely export it, explain the refusal instead; never fake file content.')
