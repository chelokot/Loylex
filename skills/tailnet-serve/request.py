#!/usr/bin/env python3
"""Build a loylex approval request for tailnet hosting: publish a static site, remove one, or read status.

Run as: python3 -I skills/tailnet-serve/request.py publish --job JOB --name NAME --dir DIR --out FILE
The host validates everything again; these checks only fail early and mirror its limits.
"""

import argparse
import base64
import json
import os
import re
import sys
from pathlib import PurePosixPath

NAME_PATTERN = re.compile(r"[a-z][a-z0-9-]{1,39}\Z")
FILE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}\Z")
SUFFIXES = {
    ".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif",
    ".webp", ".ico", ".txt", ".woff", ".woff2",
}
MAX_FILES = 200
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024


def fail(message: str) -> None:
    sys.exit(f"tailnet request refused: {message}")


def site_files(directory: str) -> dict[str, str]:
    root = os.path.realpath(directory)
    if not os.path.isdir(root):
        fail(f"{directory} is not a directory")
    files: dict[str, str] = {}
    total = 0
    for current, subdirectories, names in os.walk(root, followlinks=False):
        # Hidden directories such as .git are not published.
        subdirectories[:] = sorted(item for item in subdirectories if not item.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            path = os.path.join(current, name)
            relative = PurePosixPath(os.path.relpath(path, root)).as_posix()
            if os.path.islink(path):
                fail(f"symlink not allowed: {relative}")
            if not os.path.isfile(path):
                fail(f"not a regular file: {relative}")
            if not FILE_PATTERN.fullmatch(relative) or ".." in relative:
                fail(f"file name not allowed: {relative}")
            if PurePosixPath(relative).suffix.lower() not in SUFFIXES:
                fail(f"file type not allowed: {relative}")
            with open(path, "rb") as stream:
                data = stream.read()
            if len(data) > MAX_FILE_BYTES:
                fail(f"{relative} is larger than 2 MiB")
            total += len(data)
            files[relative] = base64.b64encode(data).decode()
    if not 1 <= len(files) <= MAX_FILES:
        fail("a site needs 1 to 200 files")
    if "index.html" not in files:
        fail("a site needs index.html at its root")
    if total > MAX_TOTAL_BYTES:
        fail("the site is larger than 4 MiB")
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    publish = commands.add_parser("publish")
    publish.add_argument("--job", type=int, required=True)
    publish.add_argument("--name", required=True)
    publish.add_argument("--dir", required=True)
    publish.add_argument("--out", required=True)
    remove = commands.add_parser("remove")
    remove.add_argument("--job", type=int, required=True)
    remove.add_argument("--name", required=True)
    remove.add_argument("--out", required=True)
    status = commands.add_parser("status")
    status.add_argument("--job", type=int, required=True)
    status.add_argument("--out", required=True)
    arguments = parser.parse_args()

    if arguments.command == "status":
        operation = {"kind": "tailnet-status"}
    else:
        if not NAME_PATTERN.fullmatch(arguments.name):
            fail("name must start with a letter and use lowercase letters, digits or hyphens")
        if arguments.command == "remove":
            operation = {"kind": "tailnet", "action": "remove", "name": arguments.name}
        else:
            operation = {
                "kind": "tailnet",
                "action": "publish",
                "name": arguments.name,
                "files": site_files(arguments.dir),
            }
    request = {"jobId": arguments.job, "operation": operation}
    with open(arguments.out, "w", encoding="utf-8") as stream:
        json.dump(request, stream, ensure_ascii=False)
    print(json.dumps({"written": arguments.out, "action": operation.get("action", operation["kind"])}))


if __name__ == "__main__":
    main()
