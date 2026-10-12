import base64
import hashlib
import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parents[1] / "deploy/scripts"
sys.path.insert(0, str(SCRIPTS))
import loylex_approvals as broker

loader = SourceFileLoader("approval_supervisor", str(SCRIPTS / "loylex-supervisor"))
spec = importlib.util.spec_from_loader(loader.name, loader)
supervisor = importlib.util.module_from_spec(spec)
loader.exec_module(supervisor)


class LocalApprovals(broker.Approvals):
    def __init__(self, root: Path, remote: Path) -> None:
        self.remote = remote
        self.messages = []
        self.next_message = 100
        super().__init__(mock.Mock(), root)

    def _git(self, directory: Path, *arguments: str, privileged: bool = False) -> bytes:
        arguments = [
            str(self.remote) if value.startswith("https://github.com/") else value
            for value in arguments
        ]
        return broker.command(["git", "--git-dir", str(directory / "repository.git"), *arguments])

    def _review(self, identifier: str, package: bytes) -> str:
        return "Изменяется тестовый файл."

    def _telegram(self, method: str, payload: dict, document: bytes | None = None) -> dict:
        self.messages.append((method, payload, document))
        self.next_message += 1
        return {"message_id": self.next_message}


class ApprovalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.disk = mock.patch.object(
            broker.shutil, "disk_usage", return_value=mock.Mock(free=10 * 1024**3)
        )
        self.disk.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source"
        self.source.mkdir()
        self.remote = self.directory / "remote.git"
        self.git("init", "-b", "main", str(self.source))
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        (self.source / "file.txt").write_text("before\n")
        self.git("add", "file.txt")
        self.git("commit", "-m", "Initial")
        self.old_sha = self.git("rev-parse", "HEAD")
        self.git("clone", "--bare", str(self.source), str(self.remote))
        (self.source / "file.txt").write_text("after\n")
        self.git("commit", "-am", "Change")
        self.new_sha = self.git("rev-parse", "HEAD")
        bundle = self.directory / "change.bundle"
        self.git("bundle", "create", str(bundle), "HEAD", "^" + self.old_sha)
        self.operation = {
            "kind": "push",
            "repository": "owner/repository",
            "ref": "refs/heads/main",
            "newSha": self.new_sha,
            "bundle": base64.b64encode(bundle.read_bytes()).decode(),
        }
        self.approvals = LocalApprovals(self.directory / "broker", self.remote)

    def tearDown(self) -> None:
        self.approvals.database.close()
        self.temporary.cleanup()
        self.disk.stop()

    def git(self, *arguments: str) -> str:
        return broker.command(["git", *arguments], cwd=self.source).decode().strip()

    def submit(self, operation: dict | None = None) -> str:
        identifier = self.approvals.submit(
            {
                "chatId": -100,
                "replyId": 10,
                "threadId": None,
                "operation": self.operation if operation is None else operation,
            }
        )["id"]
        deadline = time.monotonic() + 5
        while (
            self.approvals.status(identifier)["state"] == "preparing"
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        self.assertEqual(
            self.approvals.status(identifier)["state"],
            "pending",
            self.approvals.status(identifier),
        )
        return identifier

    def callback(
        self,
        identifier: str,
        user: int = broker.OPERATOR_ID,
        message: int = 102,
        action: str = "approve",
        chat: int = -100,
    ) -> dict:
        return self.approvals.callback(
            {
                "id": "live-callback",
                "from": {"id": user, "is_bot": False},
                "message": {"message_id": message, "chat": {"id": chat}},
                "data": f"{action}:{identifier}",
            }
        )

    def wait_execution(self, identifier: str) -> dict:
        deadline = time.monotonic() + 5
        while (
            self.approvals.status(identifier)["state"] == "executing"
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        return self.approvals.status(identifier)

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
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "main"), self.new_sha)
        self.assertFalse(self.callback(identifier)["accepted"])

    def test_other_user_copied_button_and_wrong_chat_fail(self) -> None:
        identifier = self.submit()
        self.assertFalse(self.callback(identifier, user=849670500)["accepted"])
        self.assertFalse(self.callback(identifier, message=103)["accepted"])
        self.assertFalse(self.callback(identifier, chat=-101)["accepted"])
        self.assertEqual(self.approvals.status(identifier)["state"], "pending")

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
        self.assertEqual(document["caption"], "Пакет операции")
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

    def test_reviewer_auth_is_private_and_lifetime_is_independently_bounded(self) -> None:
        def execute(arguments: list[str], **options) -> bytes:
            if arguments[:2] == ["podman", "exec"]:
                return b'{"tokens":{"access_token":"test-only"}}'
            if arguments[:2] == ["podman", "inspect"]:
                return b"sha256:test-image"
            if arguments[:2] == ["podman", "run"]:
                self.assertIn("--timeout=180", arguments)
                self.assertIn("--userns=keep-id:uid=1000,gid=1000", arguments)
                volume = arguments[arguments.index("--volume") + 1]
                auth_path = Path(volume.split(":")[0])
                self.assertEqual(auth_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(auth_path.parent.stat().st_mode & 0o777, 0o700)
                self.assertIn(":ro,Z", volume)
                self.assertNotIn("--secret", arguments)
                return (
                    b'{"type":"item.completed","item":{"type":"agent_message","text":"Reviewed"}}'
                )
            if arguments[:2] == ["podman", "rm"]:
                return b""
            self.fail(f"Unexpected command: {arguments[0]}")

        with mock.patch.object(broker, "command", side_effect=execute):
            result = broker.Approvals._review(self.approvals, "private-auth-test", b"Operation")
        self.assertEqual(result, "Reviewed")

    def test_gateway_deployment_pins_the_built_artifact(self) -> None:
        identifier = self.submit()
        original = broker.command
        digest = "sha256:" + "1" * 64

        def execute(arguments: list[str], **options) -> bytes:
            if arguments[:2] == ["podman", "build"]:
                return b""
            if arguments[:3] == ["podman", "image", "inspect"]:
                return digest.encode()
            return original(arguments, **options)

        with mock.patch.object(broker, "command", side_effect=execute):
            result = self.approvals._deploy(
                self.approvals.root / identifier,
                {
                    "kind": "gateway",
                    "commit": self.new_sha,
                    "oldCommit": self.old_sha,
                    "buildRecipe": "FROM scratch\n",
                },
            )
        expected = "ghcr.io/chelokot/loylex-gateway@" + digest
        self.assertEqual(result["image"], expected)
        self.approvals.supervisor.deploy_gateway.assert_called_once_with(expected, self.old_sha)

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

    def test_host_http_authentication_and_agent_deploy_stays_available(self) -> None:
        supervisor.TOKEN = "agent-token"
        supervisor.GATEWAY_TOKEN = "gateway-token"
        supervisor.APPROVALS = self.approvals
        supervisor.SUPERVISOR = mock.Mock()
        supervisor.SUPERVISOR.schedule.return_value = {"state": "scheduled"}
        server = supervisor.ThreadingHTTPServer(("127.0.0.1", 0), supervisor.RequestHandler)
        gateway = supervisor.GatewayHTTPServer(("127.0.0.1", 0), supervisor.RequestHandler)
        gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        gateway_thread.start()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path: str, token: str, payload: dict, privileged: bool = False) -> int:
            connection = http.client.HTTPConnection(
                "127.0.0.1", gateway.server_port if privileged else server.server_port
            )
            connection.request(
                "POST", path, json.dumps(payload), {"Authorization": f"Bearer {token}"}
            )
            response = connection.getresponse()
            response.read()
            connection.close()
            return response.status

        try:
            self.assertEqual(request("/v1/approvals/callback", "agent-token", {}), 403)
            self.assertEqual(request("/v1/approvals/callback", "wrong-token", {}), 401)
            self.assertEqual(request("/v1/approvals/callback", "gateway-token", {}), 401)
            self.assertEqual(request("/v1/approvals/callback", "gateway-token", {}, True), 200)
            self.assertEqual(request("/v1/approvals/callback", "agent-token", {}, True), 401)
            self.assertEqual(request("/v1/deploy/gateway", "agent-token", {}), 403)
            self.assertEqual(request("/v1/deploy/all", "agent-token", {}), 403)
            self.assertEqual(request("/v1/deploy/agent", "agent-token", {}), 202)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            gateway.shutdown()
            gateway.server_close()
            gateway_thread.join()

    def test_operation_validation_rejects_extra_fields_and_path_traversal(self) -> None:
        with self.assertRaises(broker.ApprovalError):
            self.approvals._validate_operation({**self.operation, "shell": "echo privileged"})
        for resource in (
            "issues/../../user",
            "actions/runners/registration-token",
            "pulls",
        ):
            with self.assertRaises(broker.ApprovalError):
                self.approvals._validate_operation(
                    {
                        "kind": "github",
                        "repository": "owner/repo",
                        "method": "POST",
                        "resource": resource,
                        "body": {},
                    }
                )
