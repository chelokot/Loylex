import json
from unittest import mock

from approval_fixtures import ApprovalTestCase
from loylex_pr_merge import REPOSITORY


class PullRequestDeploymentTest(ApprovalTestCase):
    def setUp(self):
        super().setUp()
        self.git("push", str(self.remote), f"{self.new_sha}:refs/heads/feature")
        self.pr = {"state": "open", "draft": False, "number": 12,
                   "merge_commit_sha": self.new_sha,
                   "head": {"sha": self.new_sha, "repo": {"full_name": REPOSITORY}},
                   "base": {"sha": self.old_sha, "ref": "main", "repo": {"full_name": REPOSITORY}}}
        self.checks = {"total_count": 1, "check_runs": [{"name": "check", "status": "completed",
                       "conclusion": "success", "app": {"slug": "github-actions"}}]}
        self.operation = {"kind": "merge-pr", "repository": REPOSITORY, "number": 12}
        self.api = mock.patch.object(self.approvals, "_pr_api", side_effect=self.respond)
        self.api_mock = self.api.start()
        self.addCleanup(self.api.stop)

    def respond(self, resource, method="GET", body=None):
        if resource == "pulls/12":
            return self.pr
        if resource.endswith("/check-runs?per_page=100"):
            return self.checks
        if resource == "pulls/12/merge":
            self.assertEqual(method, "PUT")
            self.assertEqual(body, {"sha": self.new_sha, "merge_method": "merge"})
            return {"merged": True, "sha": self.new_sha}
        if resource.endswith("/statuses?per_page=100"):
            return [{"context": f"loylex-image/{component}", "state": "success",
                     "creator": {"login": "github-actions[bot]"}, "description": "sha256:"+"f"*64,
                     "target_url": "https://github.com/chelokot/Loylex/actions/runs/1"}
                    for component in ("agent", "gateway")]
        if resource.startswith("actions/runs?"):
            return self.workflows
        self.fail(resource)

    def approve(self, identifier):
        self.assertTrue(self.callback(identifier, message=self.approvals.status(identifier)["message_id"])["accepted"])
        return self.wait_execution(identifier)

    def test_pinned_merge_summary_and_checks(self):
        identifier = self.submit()
        text = self.approvals.messages[0][1]["text"]
        self.assertIn("https://github.com/chelokot/Loylex/pull/12", text)
        self.assertIsNone(self.approvals.messages[0][2])
        self.assertEqual(self.approvals.messages[0][1]["reply_markup"]["inline_keyboard"][0][0]["text"], "Одобрить и слить")
        result = self.approve(identifier)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(json.loads(result["result"])["mergeSha"], self.new_sha)
        self.assertIn("https://github.com/chelokot/Loylex/pull/12", self.approvals.messages[-1][1]["text"])

    def test_moved_head_or_base_and_failed_checks_prevent_merge(self):
        for alteration in ("head", "base", "checks", "truncated", "pending"):
            with self.subTest(alteration=alteration):
                identifier = self.submit()
                if alteration in {"head", "base"}:
                    old = self.pr[alteration]["sha"]
                    self.pr[alteration]["sha"] = "f" * 40
                elif alteration == "checks":
                    self.checks["check_runs"][0]["conclusion"] = "failure"
                elif alteration == "truncated":
                    self.checks["total_count"] = 101
                else:
                    self.checks["check_runs"][0]["status"] = "in_progress"
                self.api_mock.reset_mock()
                self.assertEqual(self.approve(identifier)["state"], "failed")
                self.assertFalse(any(call.args[0].endswith("/merge") for call in self.api_mock.call_args_list))
                if alteration in {"head", "base"}:
                    self.pr[alteration]["sha"] = old
                self.checks["check_runs"][0].update(status="completed", conclusion="success")
                self.checks["total_count"] = 1

    def test_other_user_cannot_merge(self):
        identifier = self.submit()
        self.assertFalse(self.callback(identifier, user=849670500)["accepted"])
        self.assertEqual(self.approvals.status(identifier)["state"], "pending")

    def prepare_deployment(self):
        identifier = self.submit()
        self.assertEqual(self.approve(identifier)["state"], "succeeded")
        self.pr.update(merged=True, merge_commit_sha=self.new_sha)
        self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/main", self.new_sha)
        self.workflows = {"total_count": 2, "workflow_runs": [
            {"id": index, "path": f".github/workflows/{name}.yml", "head_sha": self.new_sha,
             "head_branch": "main", "status": "completed", "conclusion": "success"}
            for index, name in enumerate(("check", "images"))]}
        (self.approvals.root / "pr-deploy-enabled").write_text("enabled\n")
        with mock.patch("loylex_pr_deploy.threading.Thread"):
            self.approvals.start_pr_deployments()
        return identifier

    def deployment_state(self, identifier):
        return self.approvals.database.execute("SELECT state FROM pr_deployments WHERE approval_id=?", (identifier,)).fetchone()[0]

    def test_build_gate_then_exact_once_install_and_notice(self):
        identifier = self.prepare_deployment()
        self.workflows["workflow_runs"][1]["status"] = "in_progress"
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_not_called()
        self.assertEqual(self.deployment_state(identifier), "awaiting-build")
        self.workflows["workflow_runs"][1]["status"] = "completed"
        self.approvals._pr_deploy_tick()
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_called_once_with(self.new_sha, {"agent": "sha256:"+"f"*64, "gateway": "sha256:"+"f"*64})
        self.assertEqual(self.deployment_state(identifier), "succeeded")
        self.assertIn("✅ PR установлен", self.approvals.messages[-1][1]["text"])
        self.assertEqual(self.approvals.messages[-1][0], "editMessageText")

    def test_failed_workflow_does_not_install(self):
        identifier = self.prepare_deployment()
        self.workflows["workflow_runs"][1]["conclusion"] = "failure"
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_not_called()
        self.assertEqual(self.deployment_state(identifier), "failed")

    def test_superseded_commit_is_not_installed(self):
        identifier = self.prepare_deployment()
        self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/main", self.old_sha)
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_not_called()
        self.assertEqual(self.deployment_state(identifier), "superseded")

    def test_changed_merged_tree_is_not_installed(self):
        identifier = self.prepare_deployment()
        self.pr["merge_commit_sha"] = self.old_sha
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_not_called()
        self.assertEqual(self.deployment_state(identifier), "failed")

    def test_failed_deploy_never_replays(self):
        identifier = self.prepare_deployment()
        self.approvals.supervisor.deploy_reviewed.side_effect = RuntimeError("failure")
        self.approvals._pr_deploy_tick()
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_called_once()
        self.assertEqual(self.deployment_state(identifier), "failed")

    def test_restart_marks_claim_interrupted(self):
        identifier = self.prepare_deployment()
        self.approvals._deployment_state(identifier, "deploying", "claimed")
        with mock.patch("loylex_pr_deploy.threading.Thread"):
            self.approvals.start_pr_deployments()
        self.approvals._pr_deploy_tick()
        self.assertEqual(self.deployment_state(identifier), "interrupted")
        self.approvals.supervisor.deploy_reviewed.assert_not_called()

    def test_host_change_does_not_silently_report_full_install(self):
        identifier = self.prepare_deployment()
        directory = self.approvals.root / identifier
        operation_path = directory / "operation.json"
        saved = json.loads(operation_path.read_bytes())
        saved["hostChanges"] = ["deploy/compose/compose.yaml"]
        from loylex_approval_host import encoded
        import hashlib
        package_path = directory / "package.txt"
        for path in (operation_path, package_path):
            path.chmod(0o600)
        package = encoded(saved) + b"\n\nreviewed host change"
        operation_path.write_bytes(encoded(saved))
        package_path.write_bytes(package)
        self.approvals._update(identifier, digest=hashlib.sha256(package).hexdigest())
        self.approvals._pr_deploy_tick()
        self.approvals.supervisor.deploy_reviewed.assert_not_called()
        self.assertEqual(self.deployment_state(identifier), "failed")

    def test_bootstrap_opt_in_required(self):
        with mock.patch("loylex_pr_deploy.threading.Thread") as thread:
            self.approvals.start_pr_deployments()
        thread.assert_not_called()
