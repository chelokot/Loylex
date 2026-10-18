import http.client
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


MAX_PACKAGE_BYTES = 8 * 1024 * 1024


class ApprovalError(Exception):
    pass


def git_failure_category(stderr: bytes) -> str:
    # Return only fixed labels: remote output can contain credentials or hostile text.
    message = stderr[:65536].lower()
    categories = (
        ("authentication rejected", (b"authentication failed", b"invalid username or token", b"could not read username")),
        ("repository access denied", (b"permission to ", b"write access to repository not granted", b"repository not found", b"error: 403")),
        ("network or TLS failure", (b"could not resolve host", b"failed to connect", b"ssl certificate problem", b"connection reset", b"unable to access")),
        ("transport prohibited", (b"transport 'https' not allowed", b"transport 'file' not allowed")),
        ("missing Git objects", (b"bad object", b"not a valid object", b"missing blob", b"missing necessary objects")),
        ("remote ref rejected", (b"stale info", b"non-fast-forward", b"protected branch", b"repository rule violations")),
    )
    for label, patterns in categories:
        if any(pattern in message for pattern in patterns):
            return label
    return "unclassified Git failure"


def encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode()


def command(
    arguments: list[str],
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input_bytes: bytes | None = None,
    timeout: int = 120,
) -> bytes:
    executable = arguments[0]
    if executable == "git":
        arguments = [
            "prlimit",
            "--as=1073741824",
            "--fsize=134217728",
            "--cpu=90",
            "--",
            *arguments,
        ]
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        result = subprocess.run(
            arguments,
            cwd=cwd,
            env=env,
            input=input_bytes,
            stdout=output,
            stderr=errors,
            timeout=timeout,
        )
        if result.returncode:
            detail = ""
            if executable == "git":
                errors.seek(0)
                detail = ": " + git_failure_category(errors.read(65536))
            raise ApprovalError(f"{executable} failed (exit {result.returncode}){detail}")
        if output.tell() > 128 * 1024 * 1024:
            raise ApprovalError("Command output exceeds size limit")
        output.seek(0)
        return output.read()


def secret(name: str) -> str:
    value = json.loads(command(["podman", "secret", "inspect", "--showsecret", name]))
    return value[0]["SecretData"].strip()


def https_request(
    host: str, path: str, method: str, body: bytes | None, headers: dict[str, str]
) -> tuple[int, bytes]:
    connection = http.client.HTTPSConnection(host, timeout=60)
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        data = response.read(MAX_PACKAGE_BYTES + 1)
        if len(data) > MAX_PACKAGE_BYTES:
            raise ApprovalError("Remote response exceeds size limit")
        return response.status, data
    finally:
        connection.close()
