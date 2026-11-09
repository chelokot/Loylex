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
        t3_endpoint(endpoint)
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
        connection = t3_https(self.host, timeout=30)
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
                raise ApprovalError("T3 access expired or was revoked; reconnect this computer" if response.status in (401, 403) else f"T3 MCP request failed (HTTP {response.status}); not retried")
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
                connection = t3_https(self.host, timeout=5)
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


# Private host storage and HTTPS for T3. These paths never enter agent mounts.
def t3_read(name: str, missing: Any = None) -> Any:
    import os
    import stat
    path = Path.home() / '.config/loylex' / name
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return missing
    except OSError:
        raise ApprovalError('Cannot open T3 host configuration safely') from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid() or info.st_size > 131072:
            raise ApprovalError('T3 host file must be owned by the host user, regular and mode 0600')
        with os.fdopen(descriptor, 'r') as stream:
            descriptor = -1
            return json.load(stream)
    except (ValueError, OSError):
        raise ApprovalError('Cannot read T3 host configuration') from None
    finally:
        if descriptor != -1:
            os.close(descriptor)


def t3_write(name: str, value: Any) -> None:
    import os
    directory = Path.home() / '.config/loylex'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = encoded(value)
    if len(data) > 131072:
        raise ApprovalError('T3 host storage limit reached')
    descriptor, temporary = tempfile.mkstemp(prefix='.t3-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / name)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def t3_endpoint(endpoint: str) -> str:
    import re
    try:
        url = urlsplit(endpoint)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or any(ord(c) <= 32 or ord(c) >= 127 for c in endpoint) or '?' in endpoint or '#' in endpoint or url.path != '/mcp'
                or url.port not in (None, 443) or len(endpoint) > 512
                or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', url.hostname)):
            raise ValueError()
        return 'https://' + url.hostname
    except (ValueError, TypeError, AttributeError):
        raise ApprovalError('Use the public HTTPS MCP URL from T3 Settings → Environments') from None


def t3_https(host: str, timeout: int = 30) -> http.client.HTTPSConnection:
    # Resolve once, reject the entire mixed answer, connect to the validated IP;
    # TLS still verifies the original hostname. No DNS rebinding or proxy envs.
    import ipaddress
    import socket
    import ssl
    class PublicHTTPS(http.client.HTTPSConnection):
        def connect(self) -> None:
            answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not answers or len(answers) > 32 or any(not (ipaddress.ip_address(row[4][0]).is_global and not ipaddress.ip_address(row[4][0]).is_multicast and not ipaddress.ip_address(row[4][0]).is_reserved) for row in answers):
                raise ApprovalError('T3 address must resolve only to public internet addresses')
            raw = socket.create_connection((answers[0][4][0], 443), timeout=timeout)
            try:
                self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
            except BaseException:
                raw.close()
                raise
    return PublicHTTPS(host, timeout=timeout)


def t3_json(origin: str, path: str, payload: dict | None = None, form: bool = False) -> dict:
    from urllib.parse import urlencode
    connection = t3_https(urlsplit(origin).hostname)
    try:
        data = None if payload is None else (urlencode(payload).encode() if form else encoded(payload))
        connection.request('GET' if payload is None else 'POST', path, data,
                           {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'})
        response = connection.getresponse()
        data = response.read(65537)
        if response.status not in (200, 201) or len(data) > 65536:
            raise ApprovalError(f'T3 OAuth request failed (HTTP {response.status}); start a new sign-in')
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except ApprovalError:
        raise
    except Exception:
        raise ApprovalError('T3 OAuth connection failed; start a new sign-in') from None
    finally:
        connection.close()


# Crypto executes fixed code in a disposable, networkless copy of the already
# installed Bun gateway image. No account token or host secret is passed to it.
T3_CRYPTO_SCRIPT = r'''
const input = JSON.parse(await Bun.stdin.text());
const enc = new TextEncoder();
const b64 = value => Buffer.from(value).toString('base64url');
const algorithm = {name:'ECDSA', namedCurve:'P-256'};
if (input.operation === 'key') {
  const key = await crypto.subtle.generateKey(algorithm, true, ['sign','verify']);
  console.log(JSON.stringify(await crypto.subtle.exportKey('jwk', key.privateKey)));
} else if (input.operation === 'sign') {
  const key = await crypto.subtle.importKey('jwk', input.key, algorithm, false, ['sign']);
  console.log(JSON.stringify(b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(input.message)))));
} else { throw new Error('Unknown crypto operation'); }
'''


def t3_crypto(payload: dict) -> Any:
    import re
    image = command(['podman', 'inspect', '--format', '{{.Image}}', 'loylex-gateway']).decode().strip()
    if not re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}', image):
        raise ApprovalError('Invalid installed Bun image identity')
    return json.loads(command([
        'podman', 'run', '--rm', '--timeout=20', '--network=none', '--read-only',
        '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--log-driver=none', '--memory=128m', '--cpus=0.5', '--pids-limit=32',
        '--tmpfs=/tmp:rw,nodev,nosuid,size=8m', '-i', '--entrypoint=bun', image,
        '-e', T3_CRYPTO_SCRIPT], input_bytes=encoded(payload), timeout=30))


class T3ProofKey:
    def __init__(self) -> None:
        import base64
        import hashlib
        self.key = t3_crypto({'operation': 'key'})
        self.jwk = {k: self.key[k] for k in ('kty', 'crv', 'x', 'y')}
        canonical = json.dumps(self.jwk, sort_keys=True, separators=(',', ':')).encode()
        self.thumbprint = base64.urlsafe_b64encode(hashlib.sha256(canonical).digest()).decode().rstrip('=')

    def proof(self, url: str, method: str, token: str | None = None, nonce: str | None = None) -> str:
        import base64
        import hashlib
        import uuid
        def part(value: Any) -> str:
            return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')
        claims = {'htu': url, 'htm': method, 'iat': int(time.time()), 'jti': uuid.uuid4().hex}
        if token:
            claims['ath'] = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip('=')
        if nonce:
            claims['nonce'] = nonce
        message = part({'typ': 'dpop+jwt', 'alg': 'ES256', 'jwk': self.jwk}) + '.' + part(claims)
        signature = t3_crypto({'operation': 'sign', 'key': self.key, 'message': message})
        if not isinstance(signature, str) or len(signature) != 86:
            raise ApprovalError('Invalid DPoP signature')
        return message + '.' + signature


def t3_native_request(origin: str, path: str, payload: dict | None = None,
                      token: str | None = None, key: T3ProofKey | None = None,
                      form: bool = False) -> tuple[int, dict]:
    from urllib.parse import urlencode
    nonce = None
    for challenge in range(2):
        connection = t3_https(urlsplit(origin).hostname)
        try:
            method = 'GET' if payload is None else 'POST'
            headers = {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
            if token:
                headers['Authorization'] = ('DPoP ' if key else 'Bearer ') + token
            if key:
                headers['DPoP'] = key.proof(origin + path, method, token, nonce)
            body = None if payload is None else urlencode(payload).encode() if form else encoded(payload)
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            data = response.read(262145)
            if len(data) > 262144:
                raise ApprovalError('T3 Connect response exceeds limit')
            supplied_nonce = response.getheader('DPoP-Nonce')
            if response.status == 401 and key and challenge == 0 and isinstance(supplied_nonce, str) and 1 <= len(supplied_nonce) <= 512 and supplied_nonce.isascii() and not any(ord(c) <= 32 for c in supplied_nonce):
                nonce = supplied_nonce
                continue  # Definitive authentication challenge, never an unknown-outcome retry.
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            return response.status, value
        except ApprovalError:
            raise
        except Exception:
            raise ApprovalError('T3 Connect request failed; outcome unknown, not retried') from None
        finally:
            connection.close()
    raise ApprovalError('T3 Connect authentication failed')
