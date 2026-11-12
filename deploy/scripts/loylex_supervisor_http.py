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
    APPROVALS = Approvals(SUPERVISOR, loopback=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(GATEWAY_CERTIFICATE_PATH, GATEWAY_KEY_PATH)
    with ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), RequestHandler) as server, GatewayHTTPServer((LISTEN_HOST, 8791), RequestHandler) as gateway:
        gateway.socket = context.wrap_socket(gateway.socket, server_side=True)
        threading.Thread(target=gateway.serve_forever, daemon=True).start()
        server.serve_forever()


# Native T3 Connect device sign-in. Enrollment is a host-owned worker, with no
# browser callback/listening port and no credential returned to the agent.
class T3OAuth:
    CLERK = 'https://clerk.t3.codes'
    RELAY = 'https://relay.t3.codes'
    CLIENT = 'hzxSgY2cH10sDU2r'  # Public CLI client ID, not a credential.
    CALLBACK = 'http://127.0.0.1/t3-native-enrollment'
    SCOPES = ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write']

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.ready = True
        self.slots = threading.BoundedSemaphore(2)
        self.accounts: dict[str, str] = {}
        self.notifications: dict[str, Any] = {}
        self.active: set[str] = set()

    def configuration(self) -> str:
        return 't3-connect-device-v1'

    def request(self, origin: str, path: str, payload: dict | None = None, **kwargs: Any) -> dict:
        from loylex_approval_host import t3_native_request
        status, value = t3_native_request(origin, path, payload, **kwargs)
        if status not in (200, 201):
            raise ApprovalError(f'T3 {path.rsplit("/", 1)[-1]} failed (HTTP {status}); not retried')
        return value

    def begin(self, machine: str, endpoint: str | None = None, environmentName: str | None = None, notify: Any = None) -> dict:
        import hashlib
        import secrets
        import time
        from urllib.parse import urlsplit
        from loylex_approval_host import t3_read, t3_write, encoded
        if not self.slots.acquire(blocking=False):
            raise ApprovalError('Two T3 sign-ins are already active; wait for expiry')
        try:
            value = self.request(self.CLERK, '/oauth/device_authorization', {
                'client_id': self.CLIENT, 'scope': 'openid profile email'}, form=True)
            code, interval, lifetime = value.get('device_code'), value.get('interval', 5), value.get('expires_in')
            link = value.get('verification_uri_complete') or value.get('verification_uri')
            if (not isinstance(code, str) or not 1 <= len(code) <= 8192 or type(interval) is not int or not 1 <= interval <= 30
                    or type(lifetime) is not int or not 60 <= lifetime <= 1800 or not isinstance(link, str) or len(link) > 2048):
                raise ApprovalError('Invalid T3 device authorization response')
            import re
            user_code = value.get('user_code')
            if not isinstance(user_code, str) or not re.fullmatch(r'[A-Za-z0-9-]{4,40}', user_code) or code in link:
                raise ApprovalError('Invalid T3 public verification code')
            url = urlsplit(link)
            if url.scheme != 'https' or url.hostname not in {'clerk.t3.codes', 't3.codes', 'app.t3.codes', 'accounts.t3.codes'} or url.port not in (None, 443) or url.username or url.password or url.fragment:
                raise ApprovalError('T3 returned an untrusted verification link')
            record = {'attemptId': secrets.token_hex(16), 'expiresAt': int(time.time()) + min(lifetime, 600),
                      'state': 'awaiting_login', 'endpoint': endpoint, 'environmentName': environmentName}
            with self.lock:
                old = t3_read('t3-machines.json', {}).get(machine)
                record['oldDigest'] = hashlib.sha256(encoded(old)).hexdigest()
                pending = t3_read('t3-pending.json', {})
                if len(pending) >= 20 and machine not in pending:
                    raise ApprovalError('T3 computer limit reached')
                previous = pending.get(machine, {}).get('attemptId')
                pending[machine] = record
                t3_write('t3-pending.json', pending)
                self.expire(previous)
            self.active.add('login:' + record['attemptId'])
            if notify:
                self.notifications[record['attemptId']] = notify
            threading.Thread(target=self.worker, args=(machine, record, code, interval), daemon=True).start()
            return {'machine': machine, 'state': 'awaiting_login', 'authorizationUrl': link,
                    'userCode': value.get('user_code', ''), 'expiresAt': record['expiresAt'],
                    'instructions': 'Open the T3 Connect link and confirm the code. No domain, SSH or local command needed.'}
        except BaseException:
            if 'record' in locals():
                self.active.discard('login:' + record['attemptId'])
                self.notifications.pop(record['attemptId'], None)
            self.slots.release()
            raise

    def lease(self, machine: str, record: dict) -> None:
        import hashlib
        import time
        from loylex_approval_host import t3_read, encoded
        pending = t3_read('t3-pending.json', {}).get(machine, {})
        if pending.get('attemptId') != record['attemptId'] or record['expiresAt'] <= time.time():
            raise ApprovalError('T3 sign-in expired or was replaced')
        old = t3_read('t3-machines.json', {}).get(machine)
        if hashlib.sha256(encoded(old)).hexdigest() != record['oldDigest']:
            raise ApprovalError('Computer configuration changed; start a new sign-in')

    def worker(self, machine: str, record: dict, code: str, interval: int) -> None:
        import time
        from loylex_approval_host import t3_native_request, t3_read, t3_write
        state = 'failed'
        try:
            while True:
                # Only authorization_pending/slow_down are polled. Transport errors,
                # denial, expiry and unknown outcomes stop without replaying enrollment.
                time.sleep(interval)
                with self.lock:
                    self.lease(machine, record)
                status, value = t3_native_request(self.CLERK, '/oauth/token', {
                    'client_id': self.CLIENT, 'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                    'device_code': code}, form=True)
                if status == 400 and value.get('error') in {'authorization_pending', 'slow_down'}:
                    if value['error'] == 'slow_down':
                        interval = min(interval + 5, 60)
                    continue
                if status != 200 or not isinstance(value.get('access_token'), str):
                    raise ApprovalError('T3 Connect login was denied or expired')
                account = value['access_token']
                self.stage(machine, record, account)
                state = 'confirmation_required'
                break
        except Exception as error:
            record['failureReason'] = str(error) if type(error) is ApprovalError else 'Internal T3 enrollment failure'
            # ApprovalError text is fixed local text, never a provider response body.
        finally:
            try:
                with self.lock:
                    pending = t3_read('t3-pending.json', {})
                    if pending.get(machine, {}).get('attemptId') == record['attemptId']:
                        pending[machine] = {**record, 'state': state}
                        t3_write('t3-pending.json', pending)
                self.notify(record['attemptId'], machine, state)
            finally:
                self.active.discard('login:' + record['attemptId'])
                self.slots.release()

    def stage(self, machine: str, record: dict, account: str) -> None:
        from loylex_approval_host import t3_endpoint, t3_read, t3_write
        # Userinfo is obtained from the authenticated fixed issuer, never from an
        # unverified JWT payload or a claimed Telegram identity.
        identity = self.request(self.CLERK, '/oauth/userinfo', token=account)
        environments = self.request(self.RELAY, '/v1/environments', token=account).get('environments')
        if not isinstance(environments, list) or len(environments) > 100:
            raise ApprovalError('Invalid environment list')
        matches = [item for item in environments if
                   (record['environmentName'] is not None and item.get('label') == record['environmentName']) or
                   (record['endpoint'] is not None and t3_endpoint(item['endpoint']['httpBaseUrl'].rstrip('/') + '/mcp') == t3_endpoint(record['endpoint']))]
        if len(matches) != 1 or not isinstance(identity.get('sub'), str) or not isinstance(identity.get('email'), str):
            raise ApprovalError('Computer or account could not be identified uniquely')
        selected = matches[0]
        origin = t3_endpoint(selected['endpoint']['httpBaseUrl'].rstrip('/') + '/mcp')
        with self.lock:
            self.lease(machine, record)
            record.update(endpoint=origin + '/mcp', environmentName=None,
                          environmentId=selected['environmentId'], computerLabel=selected.get('label', ''), accountSubject=identity['sub'], accountEmail=identity['email'])
            if len(self.accounts) >= 20:
                raise ApprovalError('T3 enrollment limit reached')
            pending = t3_read('t3-pending.json', {})
            pending[machine] = record
            t3_write('t3-pending.json', pending)
            self.accounts[record['attemptId']] = account
        import time
        timer = threading.Timer(max(0, record['expiresAt'] - time.time()), self.expire, args=(record['attemptId'],))
        timer.daemon = True
        timer.start()

    def expire(self, attempt: str) -> None:
        with self.lock:
            self.accounts.pop(attempt, None)

    def confirmation(self, machine: str, attempt: str) -> dict:
        from loylex_approval_host import t3_read
        with self.lock:
            record = t3_read('t3-pending.json', {}).get(machine, {})
            if record.get('state') != 'confirmation_required' or record.get('attemptId') != attempt or attempt not in self.accounts:
                raise ApprovalError('T3 sign-in expired, interrupted or already used; sign in again')
            self.lease(machine, record)
            return record

    def complete(self, machine: str, expected: dict) -> dict:
        from loylex_approval_host import t3_read, t3_write
        from loylex_approval_execution import complete_t3_enrollment
        with self.lock:
            record = self.confirmation(machine, expected['attemptId'])
            if record != expected:
                raise ApprovalError('T3 enrollment target changed; submit a new approval')
            account = self.accounts.pop(record['attemptId'])
            pending = t3_read('t3-pending.json', {})
            pending[machine] = {**record, 'state': 'enrolling'}
            t3_write('t3-pending.json', pending)
            self.active.add('enroll:' + record['attemptId'])
        try:
            complete_t3_enrollment(self, machine, record, account)
            state = 'connected'
            return {'machine': machine, 'state': state}
        except Exception as error:
            record['failureReason'] = str(error) if type(error) is ApprovalError else 'Internal T3 enrollment failure'
            raise
        finally:
            self.active.discard('enroll:' + record['attemptId'])
            with self.lock:
                pending = t3_read('t3-pending.json', {})
                if pending.get(machine, {}).get('attemptId') == record['attemptId']:
                    pending[machine] = {**record, 'state': locals().get('state', 'failed')}
                    t3_write('t3-pending.json', pending)

    def status(self, payload: dict) -> dict:
        import re
        if set(payload) != {'machine'} or not isinstance(payload['machine'], str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', payload['machine']):
            raise ApprovalError('Expected a T3 machine alias')
        import time
        from loylex_approval_host import t3_read
        machine = payload['machine']
        with self.lock:
            entry = t3_read('t3-machines.json', {}).get(machine)
            pending = t3_read('t3-pending.json', {}).get(machine)
            if pending and pending.get('state') in {'awaiting_login', 'enrolling', 'confirmation_required'} and not any(prefix + str(pending.get('attemptId')) in self.active for prefix in ('login:', 'enroll:')) and pending.get('attemptId') not in self.accounts:
                return {'machine': machine, 'state': 'reconnect_required'}
            if pending and pending.get('state', 'awaiting_login') in {'awaiting_login', 'confirmation_required', 'enrolling', 'failed'} and pending['expiresAt'] > time.time():
                return {'machine': machine, 'state': pending.get('state', 'awaiting_login'), 'expiresAt': pending['expiresAt'], **({'error': pending['failureReason']} if pending.get('state') == 'failed' and 'failureReason' in pending else {})}
            if not entry or entry.get('disabled'):
                return {'machine': machine, 'state': 'disconnected'}
            if 'tokenSecret' in entry:
                return {'machine': machine, 'state': 'legacy_credential'}
            credential = t3_read('t3-credentials.json', {}).get(machine, {})
            expires = credential.get('expiresAt', 0)
            state = 'connected' if credential.get('grantId') == entry.get('grantId') and expires > time.time() + 30 else 'reconnect_required'
            return {'machine': machine, 'state': state, 'expiresAt': expires}

    def notify(self, attempt: str, machine: str, state: str) -> None:
        # Status remains queryable. Telegram notification is attached by the
        # already approved connect operation; no transcript is sent here.
        callback = self.notifications.pop(attempt, None)
        if callback:
            callback(machine, state, attempt)


T3_OAUTH = T3OAuth()
