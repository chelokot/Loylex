import base64
import json
import mimetypes
import os
import shutil
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from loylex_approval_host import ApprovalError
from loylex_tailnet_policy import TAILNET_NAME_PATTERN, validate_tailnet


# Tailnet publishing: approved static sites are served on this host's tailnet name under /<name>/.
# Only `tailscale serve` routes for /<name> are changed; funnel, reset, and other paths are never touched.
TAILSCALE = "/usr/bin/tailscale"
TAILNET_PORT = 8792  # 8787 gateway, 8790 supervisor, 8791 gateway approvals listener, 8192 and 10000 are taken.
# Loopback only. tailscale serve proxies to it, and it serves nothing except tailnet site directories.
TAILNET_ORIGIN = f"http://127.0.0.1:{TAILNET_PORT}"
TAILNET_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def tailnet_sites_root() -> Path:
    return Path.home() / ".local/state/loylex-tailnet/sites"


def tailnet_target(name: str) -> str:
    # Each site proxies to its own loopback path, so the site name survives tailscale's path mapping.
    return f"{TAILNET_ORIGIN}/{name}"


def run_tailscale(arguments: list[str]) -> bytes:
    try:
        completed = subprocess.run(
            [TAILSCALE, *arguments],
            capture_output=True,
            timeout=60,
            check=False,
            env={"PATH": "/usr/bin:/bin"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ApprovalError(f"tailscale {arguments[0]} unavailable: {type(error).__name__}") from error
    if completed.returncode != 0:
        lines = completed.stderr.decode(errors="replace").strip().splitlines()
        detail = lines[-1] if lines else "no error output"
        raise ApprovalError(f"tailscale {' '.join(arguments[:2])} failed: {detail[:300]}")
    return completed.stdout


def tailnet_identity() -> tuple[str, str]:
    me = json.loads(run_tailscale(["status", "--json"])).get("Self") or {}
    dns_name = str(me.get("DNSName") or "").rstrip(".")
    address = next((ip for ip in me.get("TailscaleIPs") or [] if ":" not in ip), "")
    if not dns_name or not address:
        raise ApprovalError("Tailscale did not report this host's DNS name and IPv4 address")
    return dns_name, address


def tailnet_routes() -> dict[str, str]:
    serve = json.loads(run_tailscale(["serve", "status", "--json"]) or b"{}")
    routes: dict[str, str] = {}
    for web in (serve.get("Web") or {}).values():
        for path, handler in ((web or {}).get("Handlers") or {}).items():
            handler = handler or {}
            routes[path.rstrip("/") or "/"] = str(handler.get("Proxy") or handler.get("Path") or "")
    return routes


def tailnet_text_mentions(name: str) -> bool:
    # The text listing cross-checks the JSON parse, so a route that was not parsed is never replaced silently.
    text = run_tailscale(["serve", "status"]).decode(errors="replace")
    return any(token.endswith((f"/{name}", f"/{name}/")) for token in text.split())


def tailnet_probe(address: str, dns_name: str, name: str, index: bytes, timeout: float = 60.0) -> None:
    # Fetches the tailnet URL from this host, so a wrong proxy mapping fails before success is reported.
    context = ssl.create_default_context()
    deadline = time.monotonic() + timeout
    last = "no response"
    while True:
        try:
            with socket.create_connection((address, 443), timeout=10) as raw:
                with context.wrap_socket(raw, server_hostname=dns_name) as stream:
                    stream.sendall(f"GET /{name}/ HTTP/1.1\r\nHost: {dns_name}\r\nConnection: close\r\n\r\n".encode())
                    response = b""
                    while len(response) < 65536 and (chunk := stream.recv(8192)):
                        response += chunk
            head, _, body = response.partition(b"\r\n\r\n")
            status = head.split(b"\r\n", 1)[0].decode(errors="replace")
            if status.startswith("HTTP/1.1 200") and body.startswith(index[:256]):
                return
            last = status or "empty response"
        except OSError as error:
            last = type(error).__name__
        if time.monotonic() >= deadline:
            raise ApprovalError(f"Tailnet probe did not serve the new site: {last}")
        time.sleep(3)


def tailnet_publish(identifier: str, operation: dict[str, Any]) -> dict[str, Any]:
    name = operation["name"]
    path = f"/{name}"
    files = {relative: base64.b64decode(content, validate=True) for relative, content in operation["files"].items()}
    dns_name, address = tailnet_identity()
    ours = tailnet_target(name)
    existing = tailnet_routes().get(path)
    if existing is not None and existing != ours:
        raise ApprovalError(f"{path} already serves another target; choose another name")
    if existing is None and tailnet_text_mentions(name):
        raise ApprovalError(f"{path} exists in Tailscale but was not parsed; refusing to replace it")
    sites = tailnet_sites_root()
    sites.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = sites / name
    if target.is_symlink():
        raise ApprovalError("Site directory is a symlink; refusing to publish")
    staging = sites / f".staging-{identifier}"
    previous = sites / f".previous-{identifier}"
    swapped = created_route = False
    try:
        staging.mkdir(mode=0o700)
        for relative, data in files.items():
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        if target.exists():
            os.replace(target, previous)
        os.replace(staging, target)
        swapped = True
        if existing is None:
            run_tailscale(["serve", "--bg", "--https=443", f"--set-path={path}", ours])
            created_route = True
        if tailnet_routes().get(path) != ours:
            raise ApprovalError("Tailscale did not record the route")
        tailnet_probe(address, dns_name, name, files["index.html"])
    except Exception:
        if created_route:
            try:
                run_tailscale(["serve", "--https=443", f"--set-path={path}", "off"])
            except ApprovalError:
                pass  # The original failure is the one the operator needs to see.
        if previous.exists():
            shutil.rmtree(target, ignore_errors=True)
            os.replace(previous, target)
        elif swapped:
            shutil.rmtree(target, ignore_errors=True)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    shutil.rmtree(previous, ignore_errors=True)
    return {
        "url": f"https://{dns_name}/{name}/",
        "files": len(files),
        "bytes": sum(len(data) for data in files.values()),
    }


def tailnet_remove(name: str) -> dict[str, Any]:
    path = f"/{name}"
    ours = tailnet_target(name)
    existing = tailnet_routes().get(path)
    if existing is not None and existing != ours:
        raise ApprovalError(f"{path} serves another target; not removed")
    if existing is None and tailnet_text_mentions(name):
        raise ApprovalError(f"{path} exists in Tailscale but was not parsed; not removed")
    route_removed = existing == ours
    if route_removed:
        run_tailscale(["serve", "--https=443", f"--set-path={path}", "off"])
        if path in tailnet_routes():
            raise ApprovalError("Tailscale still lists the route after removal")
    sites = tailnet_sites_root()
    target = sites / name
    if target.is_symlink():
        raise ApprovalError("Site directory is a symlink; refusing to remove")
    files_removed = target.exists()
    if files_removed:
        trash = sites / f".removed-{uuid.uuid4().hex}"
        os.replace(target, trash)
        shutil.rmtree(trash, ignore_errors=True)
    return {"name": name, "routeRemoved": route_removed, "filesRemoved": files_removed}


def tailnet_status() -> dict[str, Any]:
    # Read-only: this runs without an approval button, so it reports only the host name, routes, and site names.
    dns_name, _ = tailnet_identity()
    sites = tailnet_sites_root()
    names = (
        sorted(item.name for item in sites.iterdir() if item.is_dir() and not item.name.startswith("."))
        if sites.exists()
        else []
    )
    return {"dnsName": dns_name, "routes": tailnet_routes(), "sites": names, "loopbackOrigin": TAILNET_ORIGIN}


class TailnetSiteHandler(BaseHTTPRequestHandler):
    server_version = "loylex-tailnet"
    sys_version = ""

    def do_GET(self) -> None:
        self._serve(send_body=True)

    def do_HEAD(self) -> None:
        self._serve(send_body=False)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, status: int, body: bytes, send_body: bool, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for key, value in {
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            **(headers or {}),
        }.items():
            self.send_header(key, value)
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _serve(self, send_body: bool) -> None:
        raw = self.path
        if not raw.startswith("/") or "\\" in raw or "\x00" in raw:
            return self._send(400, b"Bad request\n", send_body)
        target = urllib.parse.urlsplit(raw).path
        segments = target.split("/")[1:]
        name = urllib.parse.unquote(segments[0]) if segments else ""
        if not TAILNET_NAME_PATTERN.fullmatch(name):
            return self._send(404, b"Not found\n", send_body)
        if len(segments) == 1:
            return self._send(301, b"", send_body, {"Location": f"/{name}/"})
        parts = [urllib.parse.unquote(part) for part in segments[1:] if part]
        if any(part in (".", "..") or "/" in part or "\x00" in part for part in parts):
            return self._send(404, b"Not found\n", send_body)
        site = (self.server.sites_root / name).resolve()
        try:
            resolved = site.joinpath(*parts).resolve(strict=True)
            if resolved.is_dir():
                if not target.endswith("/"):
                    return self._send(301, b"", send_body, {"Location": f"{target}/"})
                resolved = (resolved / "index.html").resolve(strict=True)
        except (OSError, RuntimeError):
            return self._send(404, b"Not found\n", send_body)
        if not resolved.is_relative_to(site) or not resolved.is_file():
            return self._send(404, b"Not found\n", send_body)
        content_type = (
            TAILNET_TYPES.get(resolved.suffix.lower())
            or mimetypes.guess_type(resolved.name)[0]
            or "application/octet-stream"
        )
        return self._send(200, resolved.read_bytes(), send_body, {"Content-Type": content_type})


def start_tailnet_loopback(port: int = TAILNET_PORT) -> ThreadingHTTPServer | None:
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), TailnetSiteHandler)
    except OSError:
        # A busy port makes publishing fail its probe and roll back; it never serves anything else.
        return None
    server.sites_root = tailnet_sites_root()
    threading.Thread(target=server.serve_forever, name="loylex-tailnet", daemon=True).start()
    return server


def tailnet_execute(identifier: str, operation: dict[str, Any]) -> dict[str, Any]:
    validate_tailnet(operation)  # Defense in depth: submit already validated the approved bytes.
    if operation["action"] == "remove":
        return tailnet_remove(operation["name"])
    return tailnet_publish(identifier, operation)
