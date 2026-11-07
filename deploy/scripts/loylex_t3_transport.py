"""Small, host-only MCP client. No SDK, subprocess, redirects, or code loading."""
import http.client
import json
import time
from urllib.parse import urlsplit

from loylex_approval_host import ApprovalError

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
