import base64
import difflib
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from loylex_approval_host import MAX_PACKAGE_BYTES, ApprovalError, command, encoded, https_request, secret
from loylex_approval_validation import MAX_BUNDLE_BYTES, REPOSITORY_PATTERN, SHA_PATTERN
from loylex_approval_validation import snapshot_t3
from loylex_compose import carry_deployed_images
from loylex_supervisor_errors import SupervisorError


ZERO_SHA = "0" * 40
# Contribution snapshots keep this much history below each tip for merge-base and log ranges.
# Measured on telegramdesktop/tdesktop: about 38 MB, far below the 128 MiB per-file git limit.
CONTRIBUTION_HISTORY_DEPTH = 1000
GATEWAY_BASE_IMAGE = "docker.io/oven/bun:1.4.0-debian"
INFRASTRUCTURE_FILES = (
    "loylex-supervisor",
    "loylex_approval_execution.py",
    "loylex_approval_host.py",
    "loylex_approval_packages.py",
    "loylex_approval_review.py",
    "loylex_approval_validation.py",
    "loylex_approvals.py",
    "loylex_compose.py",
    "loylex_supervisor_errors.py",
    "loylex_supervisor_http.py",
)
# Host files that a host-config operation replaces, relative to the host user's home.
HOST_CONFIG_SOURCES = {
    "loylex-backup": ("deploy/scripts/loylex-backup", ".local/bin/loylex-backup"),
    "compose.yaml": ("deploy/compose/compose.yaml", "stack/compose.yaml"),
}
HOST_CONFIG_MODES = {"loylex-backup": 0o755, "compose.yaml": 0o644}


def read_host_file(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise ApprovalError(f"Installed host file is unavailable: {path.name}") from error


def replace_host_file(path: Path, content: bytes, mode: int) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.write_bytes(content)
    temporary.chmod(mode)
    os.replace(temporary, path)


def host_config_text(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ApprovalError("Host configuration must be UTF-8 text") from error


def carry_images(installed: bytes, approved: bytes) -> bytes:
    # Deployed image pins belong to the host's live state; the approved commit only supplies the rest.
    try:
        return carry_deployed_images(host_config_text(installed), host_config_text(approved)).encode()
    except SupervisorError as error:
        raise ApprovalError(f"Cannot keep deployed Compose images: {error}") from error


def host_config_normalized(name: str, content: bytes) -> bytes:
    # Compare everything except deployed image pins, which the supervisor changes on every deploy.
    if name != "compose.yaml":
        return content
    return b"".join(
        b"    image:\n" if line.startswith(b"    image:") else line
        for line in content.splitlines(keepends=True)
    )


class ApprovalPackages:
    def _git(self, directory: Path, *arguments: str, privileged: bool = False) -> bytes:
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(directory),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_COUNT": "4",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": "/dev/null",
            "GIT_CONFIG_KEY_1": "protocol.allow",
            "GIT_CONFIG_VALUE_1": "never",
            "GIT_CONFIG_KEY_2": "protocol.https.allow",
            "GIT_CONFIG_VALUE_2": "always",
            "GIT_CONFIG_KEY_3": "http.followRedirects",
            "GIT_CONFIG_VALUE_3": "false",
        }
        if privileged:
            credentials = base64.b64encode(
                f"x-access-token:{secret('loylex-github-token')}".encode()
            ).decode()
            env.update(
                {
                    "GIT_CONFIG_COUNT": "5",
                    "GIT_CONFIG_KEY_4": "http.https://github.com/.extraHeader",
                    "GIT_CONFIG_VALUE_4": f"Authorization: Basic {credentials}",
                }
            )
        try:
            return command(["git", "--git-dir", str(directory / "repository.git"), *arguments], env=env)
        except ApprovalError as error:
            # Only these fixed operation names may be exposed; never echo arguments.
            stage = arguments[0] if arguments and arguments[0] in {
                "push", "fetch", "ls-remote", "bundle", "rev-parse", "merge-base", "diff", "show"
            } else "operation"
            raise ApprovalError(f"Git {stage}: {error}") from error

    def _remote_sha(self, directory: Path, repository: str, ref: str) -> str:
        output = (
            self._git(directory, "ls-remote", f"https://github.com/{repository}.git", ref)
            .decode()
            .splitlines()
        )
        matching = [line.split()[0] for line in output if line.split()[1] == ref]
        return matching[0] if matching else ZERO_SHA

    def _fetch(self, directory: Path, repository: str, sha: str, depth: int | None = None) -> None:
        if sha != ZERO_SHA:
            if depth is not None and self._has_commit(directory, sha):
                # Same object, already fetched with the same bounded history: nothing to transfer.
                return
            self._git(
                directory,
                "fetch",
                "--no-tags",
                *(["--depth", str(depth)] if depth is not None else []),
                f"https://github.com/{repository}.git",
                sha,
            )

    def _has_commit(self, directory: Path, sha: str) -> bool:
        try:
            self._git(directory, "cat-file", "-e", f"{sha}^{{commit}}")
        except ApprovalError:
            return False
        return True

    def _fork_parent(self, repository: str) -> str | None:
        # Public metadata supplies comparison context, never authorization or a push target.
        status, data = https_request(
            "api.github.com", f"/repos/{repository}", "GET", b"",
            {"Accept": "application/vnd.github+json", "User-Agent": "Loylex-Approvals"},
        )
        if status != 200:
            raise ApprovalError(f"Cannot verify fork comparison base (HTTP {status})")
        metadata = json.loads(data)
        if not metadata.get("fork"):
            return None
        parent = metadata.get("parent", {}).get("full_name")
        if not isinstance(parent, str) or not REPOSITORY_PATTERN.fullmatch(parent) or ".." in parent:
            raise ApprovalError("Invalid fork parent metadata")
        return parent

    def _snapshot(self, identifier: str, operation: dict[str, Any]) -> bytes:
        directory = self.root / identifier
        operation = dict(operation)
        repository = operation.get("repository", "chelokot/Loylex")
        if operation["kind"] == "t3":
            operation = snapshot_t3(operation)
        else:
            command(["git", "init", "--bare", str(directory / "repository.git")])
        kind = operation["kind"]
        diff = b""
        if kind == "push":
            operation["oldSha"] = self._remote_sha(directory, repository, operation["ref"])
            self._fetch(directory, repository, operation["oldSha"], CONTRIBUTION_HISTORY_DEPTH)
            review_base = operation["oldSha"]
            if review_base == ZERO_SHA:
                review_base = self._remote_sha(directory, repository, "HEAD")
                self._fetch(directory, repository, review_base, CONTRIBUTION_HISTORY_DEPTH)
            parent_sha = ZERO_SHA
            if operation["oldSha"] == ZERO_SHA and operation["ref"].startswith("refs/heads/"):
                parent = self._fork_parent(repository)
                if parent is not None:
                    parent_sha = self._remote_sha(directory, parent, "HEAD")
                    if parent_sha == ZERO_SHA:
                        raise ApprovalError("Fork parent has no published comparison base")
                    self._fetch(directory, parent, parent_sha, CONTRIBUTION_HISTORY_DEPTH)
                    operation["reviewBaseRepository"] = parent
                    operation["upstreamSha"] = parent_sha
            bundle = base64.b64decode(operation.pop("bundle"), validate=True)
            if len(bundle) > MAX_BUNDLE_BYTES:
                raise ApprovalError("Bundle exceeds size limit")
            bundle_path = directory / "change.bundle"
            bundle_path.write_bytes(bundle)
            self._git(directory, "bundle", "verify", str(bundle_path))
            self._git(directory, "bundle", "unbundle", str(bundle_path))
            self._git(directory, "rev-parse", "--verify", f"{operation['newSha']}^{{commit}}")
            operation["bundleSha256"] = hashlib.sha256(bundle).hexdigest()
            head = operation["newSha"]
            if parent_sha != ZERO_SHA:
                # Like a PR: published upstream history is baseline, not this contribution.
                # No caller-supplied SHA can hide unpublished commits from review.
                operation["forkBaseSha"] = review_base
                review_base = self._git(directory, "merge-base", parent_sha, head).decode().strip()
                operation["comparisonNote"] = (
                    "New fork branch: contribution compared with the merge base of published "
                    "upstream HEAD; existing upstream history is excluded from this diff. "
                    "The destination default branch is not modified."
                )
            operation["reviewBaseSha"] = review_base
            base = review_base
            if operation["oldSha"] != ZERO_SHA:
                if operation["ref"].startswith("refs/tags/"):
                    raise ApprovalError("Existing tags cannot be replaced")
                self._git(directory, "merge-base", "--is-ancestor", base, head)
        elif kind == "pull-request":
            operation.setdefault("headRepository", repository)
            operation["headSha"] = self._remote_sha(
                directory, operation["headRepository"], f"refs/heads/{operation['head']}"
            )
            operation["baseSha"] = self._remote_sha(
                directory, repository, f"refs/heads/{operation['base']}"
            )
            if ZERO_SHA in (operation["headSha"], operation["baseSha"]):
                raise ApprovalError("PR branches must already exist")
            self._fetch(directory, repository, operation["baseSha"], CONTRIBUTION_HISTORY_DEPTH)
            self._fetch(directory, operation["headRepository"], operation["headSha"], CONTRIBUTION_HISTORY_DEPTH)
            base, head = operation["baseSha"], operation["headSha"]
        elif kind in {"gateway", "infrastructure"}:
            head = operation["commit"]
            base = self._installed_commit(kind)
            operation["oldCommit"] = base
            self._fetch(directory, repository, head)
            self._fetch(directory, repository, base)
            if kind == "gateway":
                recipe = self._git(
                    directory, "show", f"{head}:containers/gateway.Containerfile"
                ).decode()
                match = re.match(r"FROM ([a-zA-Z0-9./:@_-]+)\n", recipe)
                if match is None or len(re.findall(r"^FROM ", recipe, re.MULTILINE)) != 1:
                    raise ApprovalError("Gateway requires a single explicit base image")
                base_image = (self.root / "gateway-base-image").read_text().strip()
                if match[1] not in {GATEWAY_BASE_IMAGE, base_image}:
                    raise ApprovalError(
                        "Changing the gateway base image requires trusted host maintenance"
                    )
                operation["buildRecipe"] = recipe.replace(match[0], f"FROM {base_image}\n", 1)
            else:
                operation["files"] = list(INFRASTRUCTURE_FILES)
                operation["installedFiles"] = {
                    name: hashlib.sha256(
                        (Path.home() / ".local/bin" / name).read_bytes()
                    ).hexdigest()
                    for name in operation["files"]
                }
        elif kind == "host-config":
            operation["oldCommit"] = self._installed_commit(kind)
            self._fetch(directory, repository, operation["commit"])
            diff = self._host_config_review(directory, operation)
            base, head = ZERO_SHA, ZERO_SHA
        else:
            base, head = ZERO_SHA, ZERO_SHA
        if head != ZERO_SHA:
            comparison = [base, head] if base != ZERO_SHA else [head]
            diff = self._git(
                directory,
                "log",
                "--format=fuller",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "-p",
                f"{base}..{head}" if base != ZERO_SHA else head,
            )
            if base == ZERO_SHA:
                empty = (
                    self._git(directory, "hash-object", "-t", "tree", "--stdin").decode().strip()
                )
                comparison = [empty, head]
            diff += b"\nTARGET OBJECT\n" + self._git(directory, "cat-file", "-p", head)
            diff += b"\nFINAL TREE DIFF\n" + self._git(
                directory,
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                *comparison,
            )
        (directory / "operation.json").write_bytes(encoded(operation))
        package = encoded(operation) + b"\n\n" + diff
        if len(package) > MAX_PACKAGE_BYTES:
            raise ApprovalError("Full diff exceeds 8 MiB; split the operation")
        (directory / "package.txt").write_bytes(package)
        for name in ("operation.json", "package.txt", "request.json"):
            with (directory / name).open("rb") as stream:
                os.fsync(stream.fileno())
            (directory / name).chmod(0o400)
        return package

    def _host_config_review(self, directory: Path, operation: dict[str, Any]) -> bytes:
        # The reviewed artifact is the difference from the files installed now, not a commit range.
        commit = operation["commit"]
        files: dict[str, dict[str, str]] = {}
        review: list[str] = []
        for name, (source, destination) in HOST_CONFIG_SOURCES.items():
            installed = read_host_file(Path.home() / destination)
            approved = self._git(directory, "show", f"{commit}:{source}")
            if name == "compose.yaml":
                approved = carry_images(installed, approved)
            files[name] = {
                "installedSha256": hashlib.sha256(host_config_normalized(name, installed)).hexdigest(),
                "newSha256": hashlib.sha256(host_config_normalized(name, approved)).hexdigest(),
            }
            review.extend(difflib.unified_diff(
                host_config_text(installed).splitlines(keepends=True),
                host_config_text(approved).splitlines(keepends=True),
                fromfile=f"installed/{name}",
                tofile=f"approved/{name}",
            ))
        operation["files"] = files
        return b"\nHOST CONFIG DIFF\n" + "".join(review).encode()

    def _installed_commit(self, kind: str) -> str:
        if kind == "infrastructure":
            return (self.root / "infrastructure-commit").read_text().strip()
        if kind == "host-config":
            recorded = self.root / "host-config-commit"
            return recorded.read_text().strip() if recorded.exists() else ""
        output = (
            command(
                [
                    "podman",
                    "inspect",
                    "--format",
                    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
                    "loylex-gateway",
                ]
            )
            .decode()
            .strip()
        )
        if not SHA_PATTERN.fullmatch(output):
            raise ApprovalError("Installed gateway has no full source revision")
        return output
