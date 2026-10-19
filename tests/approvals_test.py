import gzip
import hashlib
import json
import time
from unittest import mock

from approval_fixtures import ApprovalTestCase, LocalApprovals, broker


class ApprovalTest(ApprovalTestCase):
    def test_fork_pr_snapshots_both_repositories_and_rechecks_both_branches(self) -> None:
        fork = self.directory / "fork.git"
        self.git("clone", "--bare", str(self.remote), str(fork))
        self.git("push", str(fork), f"{self.new_sha}:refs/heads/feature")
        self.approvals.remotes["https://github.com/contributor/fork.git"] = fork
        operation = {
            "kind": "pull-request", "repository": "owner/repository",
            "headRepository": "contributor/fork", "head": "feature", "base": "main",
            "title": "Change", "body": "Reviewed change",
        }
        identifier = self.submit(operation)
        directory = self.approvals.root / identifier
        saved = json.loads((directory / "operation.json").read_bytes())
        self.assertEqual((saved["headSha"], saved["baseSha"]), (self.new_sha, self.old_sha))
        package = (directory / "package.txt").read_text()
        self.assertIn('"headRepository": "contributor/fork"', package)
        self.assertIn("-before\n+after", package)
        with mock.patch.object(self.approvals, "_github", return_value={"number": 1}) as api:
            self.assertTrue(self.callback(identifier)["accepted"])
            self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
            api.assert_called_once_with({
                "repository": "owner/repository", "resource": "pulls", "method": "POST",
                "body": {"head": "contributor:feature", "head_repo": "fork", "base": "main",
                         "title": "Change", "body": "Reviewed change"},
            })
        self.git("--git-dir", str(self.remote), "fetch", str(self.source), self.new_sha)
        for repository, ref, original, changed in (
            (fork, "refs/heads/feature", self.new_sha, self.old_sha),
            (self.remote, "refs/heads/main", self.old_sha, self.new_sha),
        ):
            with self.subTest(ref=ref):
                identifier = self.submit(operation)
                self.git("--git-dir", str(repository), "update-ref", ref, changed)
                with mock.patch.object(self.approvals, "_github") as api:
                    message_id = self.approvals.status(identifier)["message_id"]
                    self.assertTrue(self.callback(identifier, message=message_id)["accepted"])
                    self.assertEqual(self.wait_execution(identifier)["state"], "failed")
                    api.assert_not_called()
                self.git("--git-dir", str(repository), "update-ref", ref, original)

    def test_same_repository_pr_and_invalid_head_repository(self) -> None:
        self.git("push", str(self.remote), f"{self.new_sha}:refs/heads/feature")
        operation = {
            "kind": "pull-request", "repository": "owner/repository", "head": "feature",
            "base": "main", "title": "Change", "body": "",
        }
        identifier = self.submit(operation)
        with mock.patch.object(self.approvals, "_github", return_value={"number": 1}) as api:
            self.assertTrue(self.callback(identifier)["accepted"])
            self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
            self.assertEqual(api.call_args[0][0]["body"], {
                "head": "feature", "base": "main", "title": "Change", "body": "",
            })
        for repository in ("../user", "owner/repo/extra", "https://github.com/owner/repo", None):
            with self.subTest(repository=repository), self.assertRaises(broker.ApprovalError):
                self.approvals._validate_operation({**operation, "headRepository": repository})

    def test_document_transport_compresses_large_packages_losslessly(self) -> None:
        for package, compressed in ((b"small package", False), (b"full diff\n" * 10000, True)):
            with self.subTest(compressed=compressed):
                with mock.patch.object(broker, "secret", return_value="test"), mock.patch.object(
                    broker, "https_request", return_value=(200, b'{"ok":true,"result":{}}')
                ) as request:
                    broker.Approvals._telegram(self.approvals, "sendDocument", {"chat_id": -1}, package)
                body = request.call_args.args[3]
                header, payload = body.split(b'name="document";', 1)[1].split(b"\r\n\r\n", 1)
                data = payload.rsplit(b"\r\n--", 1)[0]
                if compressed:
                    self.assertIn(b'filename="operation.txt.gz"', header)
                    self.assertIn(b"application/gzip", header)
                    self.assertLess(len(data), len(package))
                    self.assertEqual(gzip.decompress(data), package)
                else:
                    self.assertIn(b'filename="operation.txt"', header)
                    self.assertEqual(data, package)

    def test_full_diff_and_approved_push(self) -> None:
        identifier = self.submit()
        document = self.approvals.messages[0][2]
        self.assertIn(b"-before", document)
        self.assertIn(b"+after", document)
        self.assertEqual(
            hashlib.sha256(document).hexdigest(),
            self.approvals.status(identifier)["digest"],
        )
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.old_sha)
        self.assertTrue(self.callback(identifier)["accepted"])
        self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
        self.assertFalse(any(
            method == "sendMessage" and "succeeded" in payload.get("text", "")
            for method, payload, _ in self.approvals.messages
        ))
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.new_sha)
        self.assertFalse(self.callback(identifier)["accepted"])

    def test_decision_edits_original_notice_and_removes_buttons(self) -> None:
        for action, decision in (("approve", "✅ Одобрено"), ("cancel", "❌ Не одобрено")):
            with self.subTest(action=action):
                identifier = self.submit()
                notice = self.approvals.messages[-1][1]
                message_id = self.approvals.status(identifier)["message_id"]
                self.assertTrue(self.callback(identifier, message=message_id, action=action)["accepted"])
                edits = [payload for method, payload, _ in self.approvals.messages
                         if method == "editMessageText" and payload["message_id"] == message_id]
                self.assertEqual(edits, [{
                    "chat_id": notice["chat_id"],
                    "message_id": message_id,
                    "text": notice["text"] + "\n\n" + decision,
                    "reply_markup": {"inline_keyboard": []},
                }])
                self.assertFalse(self.callback(identifier, message=message_id, action=action)["accepted"])
                if action == "approve":
                    self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")

    def test_failed_notice_edit_does_not_change_decision_or_block_execution(self) -> None:
        for action, expected, error in (("approve", "succeeded", OSError("offline")),
                                        ("cancel", "cancelled", broker.ApprovalError("offline"))):
            identifier = self.submit()
            message_id = self.approvals.status(identifier)["message_id"]
            with mock.patch.object(self.approvals, "_telegram", side_effect=error):
                self.assertTrue(self.callback(identifier, message=message_id, action=action)["accepted"])
                self.assertEqual(self.wait_execution(identifier)["state"], expected)
            if action == "approve":
                # Restore the disposable remote for the next request's lease.
                self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/main", self.old_sha)

    def test_other_user_copied_button_and_wrong_chat_fail(self) -> None:
        identifier = self.submit()
        self.assertFalse(self.callback(identifier, user=849670500)["accepted"])
        self.assertFalse(self.callback(identifier, message=103)["accepted"])
        self.assertFalse(self.callback(identifier, chat=-101)["accepted"])
        self.assertEqual(self.approvals.status(identifier)["state"], "pending")
        self.assertFalse(any(method == "editMessageText" for method, _, _ in self.approvals.messages))

    def test_expired_and_cancelled_requests_do_not_execute(self) -> None:
        identifier = self.submit()
        self.assertTrue(self.callback(identifier, action="cancel")["accepted"])
        self.assertFalse(self.callback(identifier)["accepted"])
        self.assertEqual(self.approvals.status(identifier)["state"], "cancelled")
        second = self.submit()
        self.approvals._update(second, created=int(time.time()) - 3601)
        self.assertFalse(self.callback(second, message=104)["accepted"])
        self.assertEqual(self.approvals.status(second)["state"], "expired")
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.old_sha)

    def test_lease_rejects_branch_moved_after_review(self) -> None:
        identifier = self.submit()
        (self.source / "file.txt").write_text("concurrent\n")
        self.git("commit", "-am", "Concurrent")
        concurrent = self.git("rev-parse", "HEAD")
        self.git("push", str(self.remote), "HEAD:main")
        self.assertTrue(self.callback(identifier)["accepted"])
        self.assertEqual(self.wait_execution(identifier)["state"], "failed")
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), concurrent)

    def test_tampered_snapshot_fails_closed(self) -> None:
        identifier = self.submit()
        path = self.approvals.root / identifier / "package.txt"
        path.chmod(0o600)
        path.write_bytes(b"harmless-looking replacement")
        self.assertTrue(self.callback(identifier)["accepted"])
        self.assertEqual(self.wait_execution(identifier)["state"], "failed")
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.old_sha)

    def test_protected_messages_survive_restart_and_mixed_bulk_delete(self) -> None:
        self.submit()
        for method in (
            "editMessageText",
            "EDITMESSAGECAPTION",
            "editMessageMedia",
            "editMessageReplyMarkup",
            "deleteMessage",
            "deleteMessages",
        ):
            self.assertFalse(
                self.approvals.telegram_allowed(
                    method,
                    {"chat_id": -100, "message_id": 101, "message_ids": [99, 101]},
                )
            )
        self.assertTrue(
            self.approvals.telegram_allowed("editMessageText", {"chat_id": -100, "message_id": 99})
        )
        self.assertFalse(
            self.approvals.telegram_allowed("editMessageText", {"inline_message_id": "opaque"})
        )
        self.assertFalse(self.approvals.telegram_allowed("SETWEBHOOK", {}))
        self.assertFalse(self.approvals.telegram_allowed("deleteForumTopic", {"chat_id": -100}))
        self.approvals.database.close()
        self.approvals = LocalApprovals(self.directory / "broker", self.remote)
        self.assertFalse(
            self.approvals.telegram_allowed("deleteMessage", {"chat_id": -100, "message_id": 102})
        )

    def test_new_branch_fetches_bundle_prerequisites_and_shows_only_new_changes(
        self,
    ) -> None:
        operation = {**self.operation, "ref": "refs/heads/review"}
        identifier = self.submit(operation)
        document = self.approvals.messages[0][2]
        self.assertNotIn(b"    Initial", document)
        self.assertIn(b"    Change", document)
        self.assertTrue(self.callback(identifier)["accepted"])
        self.assertEqual(self.wait_execution(identifier)["state"], "succeeded")
        self.assertEqual(
            self.git("--git-dir", str(self.remote), "rev-parse", "review"), self.new_sha
        )

    def test_approval_notice_is_concise_and_replies_to_package(self) -> None:
        identifier = self.submit()
        document = self.approvals.messages[0][1]
        notice = self.approvals.messages[1][1]
        self.assertIn("Проверка операции: push", document["caption"])
        self.assertEqual(notice["text"], "@Chelokot\n\nTLDR: Изменяется тестовый файл.")
        self.assertEqual(notice["reply_parameters"], {"message_id": 101})
        self.assertEqual(
            notice["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
            f"approve:{identifier}",
        )
        self.assertEqual(self.approvals.status(identifier)["state"], "pending")

    def test_review_failure_is_advisory(self) -> None:
        with mock.patch.object(self.approvals, "_review", side_effect=RuntimeError("offline")):
            identifier = self.submit()
        self.assertIn("TLDR недоступен", self.approvals.status(identifier)["review"])

    def test_unknown_callback_is_ignored_and_interrupted_execution_is_not_replayed(
        self,
    ) -> None:
        self.assertFalse(self.callback("0" * 32)["accepted"])
        identifier = self.submit()
        self.approvals._update(identifier, state="executing")
        self.approvals.database.close()
        self.approvals = LocalApprovals(self.directory / "broker", self.remote)
        self.assertEqual(self.approvals.status(identifier)["state"], "interrupted")
        self.assertFalse(self.callback(identifier)["accepted"])
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.old_sha)
