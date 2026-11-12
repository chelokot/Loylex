import base64
import hashlib
import json
import re
from pathlib import PurePosixPath

from loylex_approval_host import ApprovalError


# Tailnet sites are static files published under /<name>/ on this host's tailnet name only.
TAILNET_NAME_PATTERN = re.compile(r"[a-z][a-z0-9-]{1,39}\Z")
TAILNET_FILE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}\Z")
TAILNET_SUFFIXES = frozenset({".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".txt", ".woff", ".woff2"})
TAILNET_MAX_FILES = 200
TAILNET_MAX_FILE_BYTES = 2 * 1024 * 1024
TAILNET_MAX_BYTES = 4 * 1024 * 1024


def validate_tailnet(operation: dict) -> None:
    action = operation.get("action")
    if action == "remove":
        expected = {"kind", "action", "name"}
    elif action == "publish":
        expected = {"kind", "action", "name", "files"}
    else:
        raise ApprovalError("Unsupported tailnet action")
    if set(operation) != expected:
        raise ApprovalError("Invalid tailnet operation fields")
    name = operation["name"]
    if not isinstance(name, str) or not TAILNET_NAME_PATTERN.fullmatch(name):
        raise ApprovalError("Tailnet site name must start with a letter and use lowercase letters, digits or hyphens")
    if action == "remove":
        return
    files = operation["files"]
    if not isinstance(files, dict) or not 1 <= len(files) <= TAILNET_MAX_FILES:
        raise ApprovalError("Tailnet publish needs 1 to 200 files")
    if "index.html" not in files:
        raise ApprovalError("Tailnet site needs index.html at its root")
    total = 0
    for path, content in files.items():
        if not isinstance(path, str) or not TAILNET_FILE_PATTERN.fullmatch(path) or ".." in path:
            raise ApprovalError("Invalid tailnet file path")
        if PurePosixPath(path).suffix.lower() not in TAILNET_SUFFIXES:
            raise ApprovalError(f"Unsupported tailnet file type: {path}")
        if not isinstance(content, str):
            raise ApprovalError("Tailnet file content must be base64 text")
        try:
            size = len(base64.b64decode(content, validate=True))
        except ValueError as error:
            raise ApprovalError("Invalid tailnet file encoding") from error
        if size > TAILNET_MAX_FILE_BYTES:
            raise ApprovalError("Tailnet file exceeds 2 MiB")
        total += size
    if total > TAILNET_MAX_BYTES:
        raise ApprovalError("Tailnet site exceeds 4 MiB")


def tailnet_manifest(operation: dict) -> bytes:
    # The manifest is the reviewed part of the package; file bytes are bound by the operation JSON above it.
    if operation["action"] == "remove":
        return f"\nTAILNET REMOVE\n/{operation['name']}/\n".encode()
    lines = []
    for path in sorted(operation["files"]):
        data = base64.b64decode(operation["files"][path], validate=True)
        lines.append(f"{hashlib.sha256(data).hexdigest()}  {len(data):>9}  {path}")
    return ("\nTAILNET FILES\n" + "\n".join(lines) + "\n").encode()


def tailnet_package_operation(package: bytes) -> dict | None:
    # encoded() output has no blank lines, so the first blank line ends the operation JSON.
    try:
        operation = json.loads(package.split(b"\n\n", 1)[0])
    except ValueError:
        return None
    if isinstance(operation, dict) and operation.get("kind") == "tailnet":
        return operation
    return None


def tailnet_review(operation: dict) -> str:
    if operation["action"] == "remove":
        return f"Снять маршрут /{operation['name']}/ с тейлнета хоста и удалить его файлы. Другие маршруты не меняются."
    total = sum(len(base64.b64decode(value, validate=True)) for value in operation["files"].values())
    return (
        f"Опубликовать сайт /{operation['name']}/ на тейлнете хоста: {len(operation['files'])} файлов, "
        f"{max(1, total // 1024)} КиБ. Видно только участникам тейлнета по HTTPS, публичного входа нет. "
        "Повторная публикация заменяет файлы с тем же именем."
    )
