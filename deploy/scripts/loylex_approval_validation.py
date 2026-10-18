import re
from typing import Any

from loylex_approval_host import ApprovalError, command


MAX_BUNDLE_BYTES = 20 * 1024 * 1024
REPOSITORY_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


class OperationValidation:
    @staticmethod
    def _validate_operation(operation: Any) -> None:
        if not isinstance(operation, dict):
            raise ApprovalError("operation must be an object")
        kind = operation.get("kind")
        fields = {
            "push": {"kind", "repository", "ref", "newSha", "bundle"},
            "pull-request": {"kind", "repository", "head", "base", "title", "body"},
            "github": {"kind", "repository", "method", "resource", "body"},
            "gateway": {"kind", "commit"},
            "infrastructure": {"kind", "commit"},
        }
        if kind not in fields or set(operation) not in (
            fields[kind],
            fields[kind] | ({"headRepository"} if kind == "pull-request" else set()),
        ):
            raise ApprovalError("Invalid operation fields")
        if kind in {"gateway", "infrastructure"}:
            if not isinstance(operation["commit"], str) or not SHA_PATTERN.fullmatch(
                operation["commit"]
            ):
                raise ApprovalError("A full commit SHA is required")
            return
        repositories = [operation["repository"]]
        if "headRepository" in operation:
            repositories.append(operation["headRepository"])
        for repository in repositories:
            if (
                not isinstance(repository, str)
                or not REPOSITORY_PATTERN.fullmatch(repository)
                or ".." in repository
            ):
                raise ApprovalError("repository must be owner/name")
        if kind == "push":
            if not isinstance(operation["ref"], str) or not operation["ref"].startswith(
                ("refs/heads/", "refs/tags/")
            ):
                raise ApprovalError("Only branch and tag refs can be pushed")
            command(["git", "check-ref-format", operation["ref"]])
            if not isinstance(operation["newSha"], str) or not SHA_PATTERN.fullmatch(
                operation["newSha"]
            ):
                raise ApprovalError("A full newSha is required")
            if (
                not isinstance(operation["bundle"], str)
                or len(operation["bundle"]) > MAX_BUNDLE_BYTES * 4 // 3 + 4
            ):
                raise ApprovalError("Bundle exceeds size limit")
        if kind == "pull-request":
            for key in ("head", "base"):
                if not isinstance(operation[key], str):
                    raise ApprovalError(
                        "head and base must be branch names"
                    )
                command(["git", "check-ref-format", f"refs/heads/{operation[key]}"])
            if (
                not isinstance(operation["title"], str)
                or not operation["title"].strip()
                or len(operation["title"]) > 256
            ):
                raise ApprovalError("Invalid PR title")
            if not isinstance(operation["body"], str) or len(operation["body"]) > 60000:
                raise ApprovalError("Invalid PR body")
        if kind == "github":
            resource = operation["resource"]
            if operation["method"] not in {
                "POST",
                "PATCH",
                "PUT",
                "DELETE",
            } or not isinstance(operation["body"], dict):
                raise ApprovalError("Invalid GitHub method or body")
            if not isinstance(resource, str) or not re.fullmatch(
                r"(?:issues|pulls|releases|dispatches|actions/workflows)(?:/[A-Za-z0-9_.-]+)*",
                resource,
            ):
                raise ApprovalError("Unsupported GitHub resource")
            if any(part in {".", ".."} for part in resource.split("/")):
                raise ApprovalError("Invalid GitHub resource path")
            if resource == "pulls" or resource.startswith("pulls/"):
                raise ApprovalError(
                    "Use pull-request for PR creation; other PR mutations need a new supported operation"
                )
