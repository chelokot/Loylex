import base64
import hashlib
import os
import re
from pathlib import Path
from typing import Any

from loylex_approval_host import MAX_PACKAGE_BYTES, ApprovalError, command, encoded, secret
from loylex_approval_validation import MAX_BUNDLE_BYTES, SHA_PATTERN


ZERO_SHA = "0" * 40
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

    def _fetch(self, directory: Path, repository: str, sha: str) -> None:
        if sha != ZERO_SHA:
            self._git(
                directory,
                "fetch",
                "--no-tags",
                f"https://github.com/{repository}.git",
                sha,
            )

    def _snapshot(self, identifier: str, operation: dict[str, Any]) -> bytes:
        directory = self.root / identifier
        operation = dict(operation)
        repository = operation.get("repository", "chelokot/Loylex")
        command(["git", "init", "--bare", str(directory / "repository.git")])
        kind = operation["kind"]
        diff = b""
        if kind == "push":
            operation["oldSha"] = self._remote_sha(directory, repository, operation["ref"])
            self._fetch(directory, repository, operation["oldSha"])
            review_base = operation["oldSha"]
            if review_base == ZERO_SHA:
                review_base = self._remote_sha(directory, repository, "HEAD")
                self._fetch(directory, repository, review_base)
            operation["reviewBaseSha"] = review_base
            bundle = base64.b64decode(operation.pop("bundle"), validate=True)
            if len(bundle) > MAX_BUNDLE_BYTES:
                raise ApprovalError("Bundle exceeds size limit")
            bundle_path = directory / "change.bundle"
            bundle_path.write_bytes(bundle)
            self._git(directory, "bundle", "verify", str(bundle_path))
            self._git(directory, "bundle", "unbundle", str(bundle_path))
            self._git(directory, "rev-parse", "--verify", f"{operation['newSha']}^{{commit}}")
            operation["bundleSha256"] = hashlib.sha256(bundle).hexdigest()
            base = review_base
            head = operation["newSha"]
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
            self._fetch(directory, repository, operation["baseSha"])
            self._fetch(directory, operation["headRepository"], operation["headSha"])
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

    def _installed_commit(self, kind: str) -> str:
        if kind == "infrastructure":
            return (self.root / "infrastructure-commit").read_text().strip()
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
