"""Host-only polling of durable, operator-approved merges; no inbound endpoint."""
import hashlib
import json
import re
import threading
import time
from pathlib import Path

from loylex_approval_host import ApprovalError, encoded
from loylex_approval_validation import SHA_PATTERN


class PullRequestDeployment:
    def start_pr_deployments(self) -> None:
        # Explicit bootstrap opt-in; updating agent code cannot enable this host policy.
        if not (self.root / "pr-deploy-enabled").is_file():
            return
        with self.lock:
            self.database.execute("""CREATE TABLE IF NOT EXISTS pr_deployments (
                approval_id TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT
            )""")
            self.database.execute("UPDATE pr_deployments SET state='interrupted' WHERE state='deploying'")
            self.database.commit()
        threading.Thread(target=self._poll_pr_deployments, daemon=True).start()

    def _poll_pr_deployments(self) -> None:
        while True:
            try:
                self._pr_deploy_tick()
            except Exception:
                # No remote payloads, tokens, or exception text enter logs.
                pass
            time.sleep(30)

    def _pr_deploy_tick(self) -> None:
        with self.lock:
            rows = self.database.execute("SELECT * FROM approvals WHERE state='succeeded' ORDER BY created,id").fetchall()
        for row in rows:
            result = json.loads(row["result"])
            if "mergeSha" not in result:
                continue
            identifier = row["id"]
            with self.lock:
                previous = self.database.execute("SELECT state FROM pr_deployments WHERE approval_id=?", (identifier,)).fetchone()
            if previous and previous[0] != "awaiting-build":
                continue
            try:
                directory = self.root / identifier
                package = (directory / "package.txt").read_bytes()
                if hashlib.sha256(package).hexdigest() != row["digest"]:
                    raise ApprovalError("Saved approval package changed")
                operation = json.loads((directory / "operation.json").read_bytes())
                if not package.startswith(encoded(operation) + b"\n\n"):
                    raise ApprovalError("Operation no longer matches saved package")
                if operation.get("kind") != "merge-pr":
                    raise ApprovalError("Not a PR merge approval")
                sha = result["mergeSha"]
                if not isinstance(sha, str) or not SHA_PATTERN.fullmatch(sha):
                    raise ApprovalError("Invalid merge revision")
                pr = self._pr_api(f"pulls/{operation['number']}")
                if pr.get("merged") is not True or pr.get("merge_commit_sha") != sha:
                    raise ApprovalError("PR merge no longer matches saved result")
                self._fetch(directory, "chelokot/Loylex", sha)
                tree = self._git(directory, "rev-parse", f"{sha}^{{tree}}").decode().strip()
                if tree != operation["headTree"]:
                    raise ApprovalError("Merged tree differs from reviewed tree")
                if operation.get("hostChanges"):
                    installed_tree = self.root / "pr-deploy-host-tree"
                    if not installed_tree.is_file() or installed_tree.read_text().strip() != operation["headTree"]:
                        raise ApprovalError("PR changes host infrastructure; run reviewed host bootstrap before deployment")
                # Do not install a stale deployment over a later main commit.
                if self._remote_sha(directory, "chelokot/Loylex", "refs/heads/main") != sha:
                    self._deployment_state(identifier, "superseded", "main advanced; no rollback to an older merge")
                    continue
                workflows = self._pr_api(f"actions/runs?head_sha={sha}&event=push&per_page=100")
                runs = workflows.get("workflow_runs", [])
                if workflows.get("total_count") != len(runs):
                    raise ApprovalError("Truncated workflow list")
                required = []
                for path in (".github/workflows/check.yml", ".github/workflows/images.yml"):
                    matching = [run for run in runs if run.get("path") == path and run.get("head_sha") == sha
                                and run.get("head_branch") == "main"]
                    if not matching:
                        required.append(None)
                    else:
                        required.append(max(matching, key=lambda run: run["id"]))
                if any(run and run.get("status") == "completed" and run.get("conclusion") != "success" for run in required):
                    raise ApprovalError("Merged commit workflow failed")
                if any(not run or run.get("status") != "completed" for run in required):
                    if time.time() > row["created"] + 7200:
                        raise ApprovalError("Timed out waiting for merged commit workflows")
                    self._deployment_state(identifier, "awaiting-build", "waiting for Check and Images")
                    continue
                statuses = self._pr_api(f"commits/{sha}/statuses?per_page=100")
                image_run = required[1]["id"]
                images = {}
                for component in ("agent", "gateway"):
                    matching = [status for status in statuses if status.get("context") == f"loylex-image/{component}"]
                    if not matching:
                        raise ApprovalError("Missing CI image digest")
                    status = matching[0]  # GitHub returns statuses newest first.
                    digest = status.get("description", "")
                    if (status.get("state") != "success" or status.get("creator", {}).get("login") != "github-actions[bot]"
                            or status.get("target_url") != f"https://github.com/chelokot/Loylex/actions/runs/{image_run}"
                            or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
                        raise ApprovalError("CI digest does not match successful build run")
                    images[component] = digest
                # Claim durably before any mutation. A crash never silently replays a deployment.
                with self.execution_lock:
                    self._deployment_state(identifier, "deploying", sha)
                    self.supervisor.deploy_reviewed(sha, images)
                    self._deployment_state(identifier, "succeeded", sha)
                self._deployment_notice(row, f"✅ PR установлен: {sha[:12]}")
            except Exception as error:
                detail = str(error) if isinstance(error, ApprovalError) else type(error).__name__
                self._deployment_state(identifier, "failed", detail)
                self._deployment_notice(row, f"❌ Установка PR остановлена: {detail}")

    def _deployment_state(self, identifier: str, state: str, detail: str) -> None:
        with self.lock:
            self.database.execute("INSERT INTO pr_deployments VALUES (?,?,?) ON CONFLICT(approval_id) DO UPDATE SET state=excluded.state,detail=excluded.detail", (identifier, state, detail))
            self.database.commit()

    def _deployment_notice(self, row, text: str) -> None:
        try:
            self._telegram("editMessageText", {"chat_id": row["chat_id"], "message_id": row["message_id"],
                "text": self._saved_notice(row) + "\n\n" + text,
                "reply_markup": {"inline_keyboard": []}})
        except Exception:
            pass
