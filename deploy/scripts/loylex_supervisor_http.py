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
    start_t3_callback()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(GATEWAY_CERTIFICATE_PATH, GATEWAY_KEY_PATH)
    with ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), RequestHandler) as server, GatewayHTTPServer((LISTEN_HOST, 8791), RequestHandler) as gateway:
        gateway.socket = context.wrap_socket(gateway.socket, server_side=True)
        threading.Thread(target=gateway.serve_forever, daemon=True).start()
        server.serve_forever()


# OAuth belongs to the host HTTP boundary, never to the requesting agent.
# Kept in an existing installed module so the pre-T3 updater can bootstrap it.
class T3OAuth:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.ready = False

    def configuration(self) -> str:
        from urllib.parse import urlsplit
        from loylex_approval_host import t3_read, t3_endpoint
        config = t3_read('t3-oauth.json')
        if not isinstance(config, dict) or set(config) != {'callbackUrl'}:
            raise ApprovalError('Host setup needed: configure the HTTPS T3 OAuth callback; see docs/t3-approval-bridge.md')
        callback = config['callbackUrl']
        if not isinstance(callback, str) or urlsplit(callback).path != '/t3/callback':
            raise ApprovalError('T3 callback must use HTTPS /t3/callback')
        t3_endpoint(callback.removesuffix('/t3/callback') + '/mcp')
        return callback

    def begin(self, machine: str, endpoint: str) -> dict:
        import base64
        import hashlib
        import secrets
        import time
        from urllib.parse import urlencode
        from loylex_approval_host import t3_endpoint, t3_json, t3_read, t3_write
        with self.lock:
            callback = self.configuration()
            if not self.ready:
                raise ApprovalError('T3 callback listener is not active; finish host setup and restart supervisor')
            origin = t3_endpoint(endpoint)
            metadata = t3_json(origin, '/.well-known/oauth-authorization-server')
            expected = {'issuer': origin, 'authorization_endpoint': origin + '/oauth/mcp/authorize',
                        'token_endpoint': origin + '/oauth/mcp/token', 'registration_endpoint': origin + '/oauth/mcp/register'}
            if any(metadata.get(k) != v for k, v in expected.items()) or 'S256' not in metadata.get('code_challenge_methods_supported', []):
                raise ApprovalError('T3 OAuth metadata does not match the reviewed protocol')
            client = t3_json(origin, '/oauth/mcp/register', {
                'client_name': 'Loylex · Telegram approvals', 'redirect_uris': [callback],
                'grant_types': ['authorization_code'], 'response_types': ['code'], 'token_endpoint_auth_method': 'none'})
            client_id = client.get('client_id')
            if not isinstance(client_id, str) or not 1 <= len(client_id) <= 8192:
                raise ApprovalError('Invalid T3 OAuth client registration')
            pending = t3_read('t3-pending.json', {})
            now = int(time.time())
            pending = {k: v for k, v in pending.items() if v['expiresAt'] > now}
            if len(pending) >= 20 and machine not in pending:
                raise ApprovalError('Too many pending T3 connections')
            verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
            registry = t3_read('t3-machines.json', {})
            old = registry.get(machine)
            pending[machine] = {'origin': origin, 'clientId': client_id, 'callback': callback,
                                'verifier': verifier, 'state': state, 'expiresAt': now + 600,
                                'oldDigest': hashlib.sha256(json.dumps(old, sort_keys=True).encode()).hexdigest()}
            t3_write('t3-pending.json', pending)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
            url = origin + '/oauth/mcp/authorize?' + urlencode({
                'client_id': client_id, 'redirect_uri': callback, 'response_type': 'code',
                'code_challenge_method': 'S256', 'code_challenge': challenge,
                'state': state, 'resource': origin + '/mcp', 'scope': 'orchestration:read orchestration:operate'})
            return {'machine': machine, 'state': 'awaiting_login', 'authorizationUrl': url,
                    'expiresAt': now + 600, 'instructions': 'Open the link, approve Full access in T3. Never paste codes or tokens into Telegram.'}

    def finish(self, query: str) -> None:
        import hashlib
        import secrets
        import time
        from urllib.parse import parse_qs
        from loylex_approval_host import t3_json, t3_read, t3_write
        params = parse_qs(query, keep_blank_values=True, max_num_fields=8)
        if any(len(v) != 1 for v in params.values()) or not {'state', 'iss'} <= set(params) or not set(params) <= {'state', 'iss', 'code', 'error', 'error_description'}:
            raise ApprovalError('Invalid sign-in response')
        with self.lock:
            pending = t3_read('t3-pending.json', {})
            match = [(k, v) for k, v in pending.items() if hmac.compare_digest(v['state'], params['state'][0])]
            if len(match) != 1:
                raise ApprovalError('Sign-in expired or already used; request a new link')
            machine, saved = match[0]
            if saved['expiresAt'] <= time.time() or params['iss'][0] != saved['origin'] or saved['callback'] != self.configuration():
                raise ApprovalError('Sign-in expired or issuer changed; request a new link')
            registry = t3_read('t3-machines.json', {})
            old = registry.get(machine)
            if hashlib.sha256(json.dumps(old, sort_keys=True).encode()).hexdigest() != saved['oldDigest']:
                raise ApprovalError('Computer configuration changed; request a new link')
            # Durable single-use transition BEFORE exchanging a code, including unknown outcomes.
            del pending[machine]
            t3_write('t3-pending.json', pending)
            if 'error' in params or not params.get('code', [''])[0]:
                raise ApprovalError('Sign-in cancelled; no access saved')
            value = t3_json(saved['origin'], '/oauth/mcp/token', {
                'grant_type': 'authorization_code', 'code': params['code'][0],
                'client_id': saved['clientId'], 'redirect_uri': saved['callback'],
                'code_verifier': saved['verifier'], 'resource': saved['origin'] + '/mcp'}, form=True)
            token, expires = value.get('access_token'), value.get('expires_in')
            scope = value.get('scope')
            if (value.get('token_type', '').lower() != 'bearer' or not isinstance(token, str)
                    or not 1 <= len(token) <= 8192 or any(ord(c) <= 32 or ord(c) >= 127 for c in token)
                    or type(expires) is not int or not 60 <= expires <= 31 * 86400
                    or not isinstance(scope, str) or set(scope.split()) != {'orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write'}):
                raise ApprovalError('T3 did not grant the required access; reconnect and choose Full access')
            grant = secrets.token_hex(16)
            credentials = t3_read('t3-credentials.json', {})
            if machine not in registry and len(registry) >= 20:
                raise ApprovalError('T3 computer limit reached')
            credentials[machine] = {'accessToken': token, 'expiresAt': int(time.time()) + expires, 'grantId': grant}
            t3_write('t3-credentials.json', credentials)
            registry[machine] = {'endpoint': saved['origin'] + '/mcp', 'grantId': grant, 'projects':
                                old['projects'] if old and old['endpoint'] == saved['origin'] + '/mcp' else {}}
            t3_write('t3-machines.json', registry)


T3_OAUTH = T3OAuth()


class T3CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        from urllib.parse import urlsplit
        self.connection.settimeout(10)
        status, text = 200, 'Готово. T3 подключён к Loylex. Можно закрыть страницу и вернуться в Telegram.'
        try:
            if len(self.path) > 16384 or urlsplit(self.path).path != '/t3/callback':
                raise ApprovalError('Unknown callback')
            T3_OAUTH.finish(urlsplit(self.path).query)
        except (ApprovalError, ValueError, TypeError, KeyError):
            status, text = 400, 'Вход не завершён. Запросите новую ссылку у Loylex. Коды и токены в чат отправлять не нужно.'
        except Exception:
            status, text = 503, 'Подключение не удалось. Запросите новую ссылку у Loylex.'
        body = text.encode()
        self.send_response(status)
        for key, value in {'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': str(len(body)),
                           'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                           'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
                           'X-Content-Type-Options': 'nosniff'}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: Any) -> None:
        pass  # The callback URL contains a single-use code. Never log it.


class T3CallbackServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(('127.0.0.1', 8792), T3CallbackHandler)

    def get_request(self) -> Any:
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def start_t3_callback() -> None:
    from loylex_approval_host import t3_read
    # Missing configuration does not affect normal supervisor availability.
    try:
        if t3_read('t3-oauth.json') is None:
            return
        T3_OAUTH.configuration()
        server = T3CallbackServer()
    except Exception:
        return  # Connect reports the actionable failure; other services stay up.
    T3_OAUTH.ready = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
