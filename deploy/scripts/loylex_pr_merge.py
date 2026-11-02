"""Pinned PR approval. No changes to Telegram principal extraction or callback checks."""
import json
from typing import Any

from loylex_approval_host import ApprovalError, encoded, https_request, secret
from loylex_approval_validation import SHA_PATTERN

REPOSITORY = "chelokot/Loylex"


class PullRequestMerge:
    def _pr_api(self, resource: str, method: str = "GET", body: Any = None) -> Any:
        status, data = https_request(
            "api.github.com", f"/repos/{REPOSITORY}/{resource}", method,
            encoded(body) if body is not None else None,
            {"Authorization": f"Bearer {secret('loylex-github-token')}",
             "Accept": "application/vnd.github+json", "Content-Type": "application/json",
             "User-Agent": "Loylex-PR-deploy"},
        )
        if status < 200 or status >= 300:
            raise ApprovalError(f"GitHub PR operation failed (HTTP {status})")
        return json.loads(data)

    def _read_pr(self, number: int) -> dict:
        pr = self._pr_api(f"pulls/{number}")
        if (pr.get("state") != "open" or pr.get("draft") is not False
                or pr.get("base", {}).get("ref") != "main"
                or pr.get("base", {}).get("repo", {}).get("full_name") != REPOSITORY
                or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY):
            raise ApprovalError("Expected an open, non-draft Loylex PR targeting main")
        if any(not SHA_PATTERN.fullmatch(str(pr.get(key, {}).get("sha", "")))
               for key in ("head", "base")):
            raise ApprovalError("PR has invalid revisions")
        return pr

    def _snapshot_pr(self, directory, operation: dict) -> tuple[str, str]:
        pr = self._read_pr(operation["number"])
        for key in ("head", "base"):
            operation[f"{key}Sha"] = pr[key]["sha"]
            self._fetch(directory, REPOSITORY, pr[key]["sha"])
        base, head = operation["baseSha"], operation["headSha"]
        # A merge must produce the exact reviewed head tree, including current main.
        self._git(directory, "merge-base", "--is-ancestor", base, head)
        changed = self._git(directory, "diff", "--name-only", base, head).decode().splitlines()
        operation["hostChanges"] = [path for path in changed if path.startswith(
            ("deploy/scripts/", "deploy/compose/", "deploy/systemd/"))]
        operation["headTree"] = self._git(directory, "rev-parse", f"{head}^{{tree}}").decode().strip()
        operation["url"] = f"https://github.com/{REPOSITORY}/pull/{operation['number']}"
        return base, head

    def _merge_pr(self, operation: dict) -> dict:
        pr = self._read_pr(operation["number"])
        if any(pr[key]["sha"] != operation[f"{key}Sha"] for key in ("head", "base")):
            raise ApprovalError("PR changed after approval preparation; submit a new request")
        # GitHub enforces branch protection in addition to this explicit Check gate.
        # Feature pushes run Check even when GitHub's own token created the PR
        # (such PR creation does not trigger another Actions workflow). Main is
        # already an ancestor, so the reviewed/tested head is the resulting tree.
        checks = self._pr_api(f"commits/{operation['headSha']}/check-runs?per_page=100")
        runs = checks.get("check_runs", [])
        if checks.get("total_count") != len(runs) or not runs:
            raise ApprovalError("Missing or truncated PR checks")
        trusted = [run for run in runs if run.get("app", {}).get("slug") == "github-actions"]
        if not any(run.get("name") == "check" for run in trusted):
            raise ApprovalError("Required Check workflow is missing")
        if any(run.get("status") != "completed" or run.get("conclusion") != "success" for run in runs):
            raise ApprovalError("PR checks must all succeed before merge")
        result = self._pr_api(f"pulls/{operation['number']}/merge", "PUT",
                              {"sha": operation["headSha"], "merge_method": "merge"})
        if result.get("merged") is not True or not SHA_PATTERN.fullmatch(str(result.get("sha", ""))):
            raise ApprovalError("GitHub did not confirm merge")
        return {"mergeSha": result["sha"], "url": operation["url"], "deployment": "awaiting-build"}
