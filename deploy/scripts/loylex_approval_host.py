import http.client
import json
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
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


# Host-only T3 MCP transport; kept here for compatibility with existing updater file sets.
MAX_RESPONSE = 2 * 1024 * 1024
PROTOCOL = "2025-03-26"


class T3Transport:
    def __init__(self, endpoint: str, token: str) -> None:
        if not isinstance(endpoint, str):
            raise ApprovalError("Invalid T3 endpoint")
        url = urlsplit(endpoint)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path != "/mcp" or url.port not in (None, 443)):
            raise ApprovalError("T3 endpoint must be an HTTPS /mcp URL on port 443")
        if not token or any(c in token for c in "\r\n"):
            raise ApprovalError("Invalid T3 credential")
        self.host = url.hostname
        self.token = token
        self.session = None
        self.protocol = PROTOCOL
        self.sequence = 0

    def _post(self, message: dict) -> dict | None:
        connection = http.client.HTTPSConnection(self.host, timeout=30)
        deadline = time.monotonic() + 30
        try:
            headers = {
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": self.protocol,
            }
            if self.session:
                headers["Mcp-Session-Id"] = self.session
            connection.request("POST", "/mcp", json.dumps(message).encode(), headers)
            response = connection.getresponse()
            if response.status not in (200, 202, 204):
                # Do not leak a remote error, credential, location or session ID.
                raise ApprovalError(f"T3 MCP request failed (HTTP {response.status}); not retried")
            session = response.getheader("Mcp-Session-Id")
            if session:
                if len(session) > 512 or any(c in session for c in "\r\n"):
                    raise ApprovalError("Invalid MCP session")
                self.session = session
            if "id" not in message:
                return None
            content_type = response.getheader("Content-Type", "").split(";")[0].strip()
            if content_type == "application/json":
                data = bytearray()
                while True:
                    if time.monotonic() > deadline:
                        raise ApprovalError("T3 response deadline exceeded")
                    chunk = response.read1(min(65536, MAX_RESPONSE + 1 - len(data)))
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE:
                        raise ApprovalError("T3 response exceeds limit")
                    if not chunk:
                        break
                result = json.loads(data)
                if not isinstance(result, dict) or result.get("id") != message["id"]:
                    raise ApprovalError("Mismatched MCP response")
                return result
            if content_type != "text/event-stream":
                raise ApprovalError("Unsupported MCP response type")
            total = 0
            event = []
            while True:
                if time.monotonic() > deadline:
                    raise ApprovalError("T3 response deadline exceeded")
                line = response.readline(MAX_RESPONSE + 1)
                total += len(line)
                if total > MAX_RESPONSE:
                    raise ApprovalError("T3 response exceeds limit")
                if not line:
                    raise ApprovalError("MCP stream ended without a response")
                if line in (b"\n", b"\r\n"):
                    if event:
                        result = json.loads(b"\n".join(event))
                        if isinstance(result, dict) and result.get("id") == message["id"]:
                            return result
                    event = []
                elif line.startswith(b"data:"):
                    event.append(line[5:].lstrip(b" ").rstrip(b"\r\n"))
        except ApprovalError:
            raise
        except Exception:
            raise ApprovalError("T3 transport failed; outcome unknown, inspect before resubmitting") from None
        finally:
            connection.close()

    def _rpc(self, method: str, params: dict) -> dict:
        self.sequence += 1
        reply = self._post({"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params})
        if not reply or "error" in reply or not isinstance(reply.get("result"), dict):
            raise ApprovalError("T3 MCP error; outcome unknown, inspect before resubmitting")
        return reply["result"]

    def call(self, tool: str, arguments: dict) -> dict:
        try:
            return self._call(tool, arguments)
        finally:
            if self.session:
                connection = http.client.HTTPSConnection(self.host, timeout=5)
                try:
                    connection.request("DELETE", "/mcp", headers={
                        "Authorization": f"Bearer {self.token}",
                        "Mcp-Session-Id": self.session,
                        "MCP-Protocol-Version": self.protocol,
                    })
                    connection.getresponse().close()
                except Exception:
                    pass  # Cleanup never retries or changes the operation's outcome.
                finally:
                    connection.close()

    def _call(self, tool: str, arguments: dict) -> dict:
        initialized = self._rpc("initialize", {
            "protocolVersion": PROTOCOL, "capabilities": {},
            "clientInfo": {"name": "loylex-host-bridge", "version": "1"},
        })
        version = initialized.get("protocolVersion")
        if version not in (PROTOCOL, "2025-06-18", "2025-11-25"):
            raise ApprovalError("Unsupported MCP protocol")
        self.protocol = version
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        result = self._rpc("tools/call", {"name": tool, "arguments": arguments})
        if result.get("isError"):
            raise ApprovalError("T3 tool refused the request; not retried")
        value = result.get("structuredContent")
        if value is None:
            blocks = result.get("content", [])
            if len(blocks) == 1 and blocks[0].get("type") == "text":
                try:
                    value = json.loads(blocks[0]["text"])
                except (ValueError, KeyError):
                    pass
        if not isinstance(value, dict) or value.get("_tag") == "OrchestratorMcpFailure":
            raise ApprovalError("Unexpected T3 tool result; not retried")
        return value
