import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from loylex_approval_host import ApprovalError, command, encoded, https_request, secret


class ApprovalExecution:
    def _github(self, operation: dict[str, Any]) -> dict[str, Any]:
        status, data = https_request(
            "api.github.com",
            f"/repos/{operation['repository']}/{operation['resource']}",
            operation["method"],
            encoded(operation["body"]),
            {
                "Authorization": f"Bearer {secret('loylex-github-token')}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "Loylex-Approvals",
            },
        )
        if status < 200 or status >= 300:
            raise ApprovalError(f"GitHub operation failed (HTTP {status})")
        result = json.loads(data) if data else {}
        return {
            "status": status,
            "url": result.get("html_url"),
            "number": result.get("number"),
            "id": result.get("id"),
        }

    def _execute(self, identifier: str) -> None:
        with self.execution_lock:
            self._execute_once(identifier)

    def _execute_once(self, identifier: str) -> None:
        try:
            directory = self.root / identifier
            package = (directory / "package.txt").read_bytes()
            row = self._row(identifier)
            if hashlib.sha256(package).hexdigest() != row["digest"]:
                raise ApprovalError("Saved package changed")
            operation = json.loads((directory / "operation.json").read_bytes())
            if not package.startswith(encoded(operation) + b"\n\n"):
                raise ApprovalError("Operation does not match package")
            kind = operation["kind"]
            if kind == "push":
                if (
                    hashlib.sha256((directory / "change.bundle").read_bytes()).hexdigest()
                    != operation["bundleSha256"]
                ):
                    raise ApprovalError("Saved bundle changed")
                self._git(
                    directory,
                    "push",
                    "--porcelain",
                    "--atomic",
                    f"--force-with-lease={operation['ref']}:{operation['oldSha']}",
                    f"https://github.com/{operation['repository']}.git",
                    f"{operation['newSha']}:{operation['ref']}",
                    privileged=True,
                )
                result = {"newSha": operation["newSha"], "ref": operation["ref"]}
            elif kind == "pull-request":
                head_repository = operation.get("headRepository", operation["repository"])
                for key in ("head", "base"):
                    repository = head_repository if key == "head" else operation["repository"]
                    if (
                        self._remote_sha(
                            directory,
                            repository,
                            f"refs/heads/{operation[key]}",
                        )
                        != operation[f"{key}Sha"]
                    ):
                        raise ApprovalError("PR branch changed; submit a new request")
                body = {key: operation[key] for key in ("head", "base", "title", "body")}
                if head_repository != operation["repository"]:
                    owner, repository = head_repository.split("/")
                    body["head"] = f"{owner}:{operation['head']}"
                    body["head_repo"] = repository
                result = self._github(
                    {
                        "repository": operation["repository"],
                        "resource": "pulls",
                        "method": "POST",
                        "body": body,
                    }
                )
            elif kind in {"gateway", "infrastructure"}:
                if self._installed_commit(kind) != operation["oldCommit"]:
                    raise ApprovalError("Installed infrastructure changed; submit a new request")
                result = self._deploy(directory, operation)
            else:
                result = self._github(operation)
            self._update(
                identifier,
                state="succeeded",
                result=json.dumps(result, ensure_ascii=False),
            )
        except Exception as error:
            detail = str(error) if isinstance(error, ApprovalError) else type(error).__name__
            self._update(identifier, state="failed", result=detail)
        row = self._row(identifier)
        if row["state"] == "succeeded":
            return
        try:
            self._telegram(
                "sendMessage",
                {
                    "chat_id": row["chat_id"],
                    "text": f"{identifier}: {row['state']}\n{row['result']}",
                    "reply_parameters": {"message_id": row["message_id"]},
                },
            )
        except ApprovalError:
            pass

    def _deploy(self, directory: Path, operation: dict[str, Any]) -> dict[str, Any]:
        commit = operation["commit"]
        source = directory / "source"
        source.mkdir()
        archive = self._git(directory, "archive", commit)
        command(
            [
                "tar",
                "-x",
                "-C",
                str(source),
                "--no-same-owner",
                "--no-same-permissions",
            ],
            input_bytes=archive,
        )
        if operation["kind"] == "infrastructure":
            for name in operation["files"]:
                candidate = source / "deploy/scripts" / name
                if not candidate.is_file() or not candidate.resolve().is_relative_to(
                    source.resolve()
                ):
                    raise ApprovalError(f"Missing regular infrastructure file: {name}")
                installed = Path.home() / ".local/bin" / name
                if (
                    hashlib.sha256(installed.read_bytes()).hexdigest()
                    != operation["installedFiles"][name]
                ):
                    raise ApprovalError("Installed infrastructure file changed")
            for name in operation["files"]:
                destination = Path.home() / ".local/bin" / name
                temporary = destination.with_suffix(".new")
                shutil.copyfile(source / "deploy/scripts" / name, temporary)
                temporary.chmod(0o755)
                os.replace(temporary, destination)
            (self.root / "infrastructure-commit").write_text(commit)
            command(
                [
                    "systemd-run",
                    "--user",
                    "--on-active=10s",
                    "systemctl",
                    "--user",
                    "restart",
                    "loylex-supervisor.service",
                ]
            )
            return {
                "commit": commit,
                "restart": "scheduled",
                "files": operation["files"],
            }
        image = f"ghcr.io/chelokot/loylex-gateway:approved-{commit}"
        recipe = directory / "gateway.Containerfile"
        recipe.write_text(operation["buildRecipe"])
        command(
            [
                "podman",
                "build",
                "--memory=1g",
                "--cpu-period=100000",
                "--cpu-quota=100000",
                "--pull=never",
                "--label",
                f"org.opencontainers.image.revision={commit}",
                "--tag",
                image,
                "--file",
                str(recipe),
                str(source),
            ],
            timeout=900,
        )
        digest = (
            command(["podman", "image", "inspect", "--format", "{{.Digest}}", image])
            .decode()
            .strip()
        )
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ApprovalError("Invalid built gateway image digest")
        image = f"ghcr.io/chelokot/loylex-gateway@{digest}"
        self.supervisor.deploy_gateway(image, operation["oldCommit"])
        return {"commit": commit, "image": image}
