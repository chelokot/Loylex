import hmac
import json
import os
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from loylex_approval_host import ApprovalError
from loylex_approvals import Approvals
from loylex_supervisor_errors import BusyError, SupervisorError


LISTEN_HOST = os.environ.get("LOYLEX_SUPERVISOR_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LOYLEX_SUPERVISOR_LISTEN_PORT", "8790"))
TOKEN_PATH = Path(
    os.environ.get("LOYLEX_SUPERVISOR_TOKEN_FILE", str(Path.home() / ".config/loylex/supervisor-token"))
)
GATEWAY_TOKEN_PATH = Path.home() / ".config/loylex/gateway-supervisor-token"
GATEWAY_CERTIFICATE_PATH = Path.home() / ".config/loylex/gateway-certificate.pem"
GATEWAY_KEY_PATH = Path.home() / ".config/loylex/gateway-key.pem"

SUPERVISOR: Any
APPROVALS: Approvals
TOKEN = ""
GATEWAY_TOKEN = ""


class GatewayHTTPServer(ThreadingHTTPServer):
    pass


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "LoylexSupervisor/1"

    def do_GET(self) -> None:
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        if self.path.startswith("/v1/approvals/") and self._gateway_authorized():
            try:
                self._json(
                    200, APPROVALS.status(self.path.removeprefix("/v1/approvals/"))
                )
            except ApprovalError as error:
                self._json(404, {"error": str(error)})
            return
        if self.path != "/v1/status":
            self._json(404, {"error": "not found"})
            return
        self._json(200, SUPERVISOR.status())

    def do_POST(self) -> None:
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        parts = self.path.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "v1":
            self._json(404, {"error": "not found"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
            limit = (
                30 * 1024 * 1024 if self.path == "/v1/approvals/submit" else 1024 * 1024
            )
            if content_length < 0 or content_length > limit:
                self._json(413, {"error": "request too large"})
                return
            payload = json.loads(self.rfile.read(content_length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("JSON object required")
            if parts[1] == "approvals":
                if not self._gateway_authorized():
                    self._json(403, {"error": "Gateway authorization required"})
                    return
                if parts[2] == "submit":
                    self._json(202, APPROVALS.submit(payload))
                elif parts[2] == "callback":
                    self._json(200, APPROVALS.callback(payload))
                elif parts[2] == "telegram-guard":
                    self._json(
                        200,
                        {
                            "allowed": APPROVALS.telegram_allowed(
                                payload["method"], payload["params"]
                            )
                        },
                    )
                else:
                    self._json(404, {"error": "not found"})
                return
            if parts[1] == "deploy" and parts[2] in {"gateway", "all"}:
                self._json(
                    403,
                    {
                        "error": "Gateway deployment requires a commit-specific Telegram approval; deploy agent separately"
                    },
                )
                return
            delay_seconds = int(payload.get("delaySeconds", 15))
            result = SUPERVISOR.schedule(parts[1], parts[2], delay_seconds)
            self._json(202, result)
        except BusyError as error:
            self._json(409, {"error": str(error)})
        except (
            SupervisorError,
            ApprovalError,
            ValueError,
            KeyError,
            TypeError,
            json.JSONDecodeError,
        ) as error:
            self._json(400, {"error": str(error)})

    def log_message(self, _: str, *arguments: Any) -> None:
        return

    def _authorized(self) -> bool:
        if isinstance(self.server, GatewayHTTPServer):
            return self._gateway_authorized()
        expected = f"Bearer {TOKEN}"
        supplied = self.headers.get("authorization", "")
        return hmac.compare_digest(supplied, expected)

    def _gateway_authorized(self) -> bool:
        return isinstance(self.server, GatewayHTTPServer) and bool(GATEWAY_TOKEN) and hmac.compare_digest(
            self.headers.get("authorization", ""), f"Bearer {GATEWAY_TOKEN}"
        )

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(supervisor: Any) -> None:
    global SUPERVISOR, APPROVALS, TOKEN, GATEWAY_TOKEN
    TOKEN = TOKEN_PATH.read_text().strip()
    if not TOKEN:
        raise SupervisorError("Supervisor token is empty")
    SUPERVISOR = supervisor
    GATEWAY_TOKEN = GATEWAY_TOKEN_PATH.read_text().strip()
    if not GATEWAY_TOKEN:
        raise SupervisorError("Gateway supervisor token is empty")
    APPROVALS = Approvals(SUPERVISOR)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(GATEWAY_CERTIFICATE_PATH, GATEWAY_KEY_PATH)
    with ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), RequestHandler) as server, GatewayHTTPServer((LISTEN_HOST, 8791), RequestHandler) as gateway:
        gateway.socket = context.wrap_socket(gateway.socket, server_side=True)
        threading.Thread(target=gateway.serve_forever, daemon=True).start()
        server.serve_forever()
