#!/usr/bin/env python3
"""Clone the configured GitLab project with full history and zip it for a Telegram upload.

Run as: python3 -I skills/gitlab-repo-zip/export_repo.py OUT_DIR

Reads ~/.config/loylex/gitlab/project-url (a plain https URL) and ~/.config/loylex/gitlab/token
(readable only by its owner). The token reaches git only through GIT_CONFIG_* environment
variables, so it never appears in argv, a remote URL, or .git/config. The zip is refused when it
contains the token or exceeds Telegram's document limit. The JSON report carries paths, counts,
and rule names, never secret values.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlsplit

CONFIG_DIR = Path.home() / ".config" / "loylex" / "gitlab"
DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
OVERLAP_BYTES = 4096
SYMLINK_ATTRIBUTES = (stat.S_IFLNK | 0o777) << 16
SECRET_RULES = {
    "gitlab-token": re.compile(rb"glpat-[A-Za-z0-9_-]{20,}"),
    "github-token": re.compile(rb"gh[pousr]_[A-Za-z0-9]{36,}"),
    "aws-access-key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "private-key": re.compile(rb"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----"),
}


class ExportError(RuntimeError):
    pass


def read_config(name: str, owner_only: bool = False) -> str:
    path = CONFIG_DIR / name
    if not path.is_file():
        raise ExportError(f"missing {path}")
    if owner_only and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ExportError(f"{path} must be readable only by its owner (chmod 600)")
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise ExportError(f"{path} is empty")
    return value


def validate_project_url(url: str) -> str:
    parts = urlsplit(url)
    unsafe = parts.username or parts.password or parts.query or parts.fragment or re.search(r"\s", url)
    if parts.scheme != "https" or not parts.hostname or unsafe:
        raise ExportError("project-url must be a plain https URL without credentials")
    return url


def project_name(url: str) -> str:
    leaf = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
    return re.sub(r"[^A-Za-z0-9._-]+", "-", leaf).strip("-") or "repo"


def git(repo: Path, *arguments: str) -> str:
    try:
        result = subprocess.run(["git", "-C", str(repo), *arguments], capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError:
        raise ExportError(f"git {arguments[0]} failed") from None
    return result.stdout.strip()


def clone(url: str, token: str, destination: Path) -> None:
    basic = base64.b64encode(f"oauth2:{token}".encode()).decode()
    environment = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": f"http.{url}.extraHeader",
        "GIT_CONFIG_VALUE_1": f"Authorization: Basic {basic}",
    }
    result = subprocess.run(
        ["git", "clone", "--quiet", "--", url, str(destination)],
        env=environment, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.replace(token, "***").replace(basic, "***").strip()
        raise ExportError(f"git clone failed: {detail}")


def add_tree(archive: zipfile.ZipFile, root: Path) -> None:
    """Store regular files and symlinks; a symlink is stored as a link, never followed."""
    for directory, subdirectories, files in os.walk(root):
        for name in files + subdirectories:
            path = Path(directory, name)
            arcname = path.relative_to(root).as_posix()
            mode = os.lstat(path).st_mode
            if stat.S_ISLNK(mode):
                info = zipfile.ZipInfo(arcname)
                info.create_system = 3
                info.external_attr = SYMLINK_ATTRIBUTES
                archive.writestr(info, os.readlink(path))
            elif stat.S_ISREG(mode):
                archive.write(path, arcname)


def scan_stream(stream: BinaryIO, needle: bytes) -> tuple[bool, set[str]]:
    tail = b""
    token_seen = False
    rules: set[str] = set()
    while chunk := stream.read(CHUNK_BYTES):
        window = tail + chunk
        token_seen = token_seen or needle in window
        rules.update(name for name, pattern in SECRET_RULES.items() if pattern.search(window))
        tail = window[-OVERLAP_BYTES:]
    return token_seen, rules


def scan_archive(zip_path: Path, token: str) -> tuple[list[str], list[dict[str, str]]]:
    needle = token.encode()
    leaked: list[str] = []
    findings: list[dict[str, str]] = []
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            with archive.open(info) as stream:
                token_seen, rules = scan_stream(stream, needle)
            if token_seen:
                leaked.append(info.filename)
            findings.extend({"path": info.filename, "rule": rule} for rule in sorted(rules))
    return leaked, findings


def export(url: str, token: str, out_dir: Path) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="gitlab-repo-", dir=out_dir))
    try:
        repo = work / "repo"
        clone(url, token, repo)
        head = git(repo, "rev-parse", "--short=12", "HEAD")
        refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin").splitlines()
        branches = [ref for ref in refs if ref != "refs/remotes/origin/HEAD"]
        attributes = repo / ".gitattributes"
        lfs = attributes.is_file() and "filter=lfs" in attributes.read_text(errors="replace")
        staged = work / "delivery.zip"
        with zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            add_tree(archive, repo)
        size = staged.stat().st_size
        if size > DOCUMENT_LIMIT_BYTES:
            raise ExportError(f"zip is {size} bytes, above Telegram's 50 MiB document limit")
        leaked, findings = scan_archive(staged, token)
        if leaked:
            raise ExportError(f"refusing to deliver: the token appears in {', '.join(leaked)}")
        zip_path = out_dir / f"{project_name(url)}-{head}.zip"
        os.replace(staged, zip_path)
        return {
            "zip": str(zip_path),
            "bytes": size,
            "head": head,
            "branches": len(branches),
            "lfs": lfs,
            "secret_findings": findings,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        print("usage: python3 -I export_repo.py OUT_DIR", file=sys.stderr)
        return 2
    os.umask(0o077)
    try:
        url = validate_project_url(read_config("project-url"))
        token = read_config("token", owner_only=True)
        report = export(url, token, Path(arguments[1]))
    except ExportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
